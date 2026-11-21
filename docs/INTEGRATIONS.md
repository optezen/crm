# Integration Hub

Migration: `supabase/migrations/0008_integration_hub.sql` (additive; 0001-0007 untouched). UI: **Builder -> Connections** (`/builder/connections`, owners/admins only).

## Trust model

An integration is **never a person**. Leads created by a connector have `created_by` / `lead_activities.actor_id` = the **connection id** (a service principal that belongs to exactly one organization) and `domain_events.actor_id = NULL`. The organization is **never read from a request**:

| Path | Who proves what | How the organization is found |
|---|---|---|
| Website Forms | the caller presents the connection **secret** (only its SHA-256 is stored); `integration_ingest_form` is callable by `anon`, so the Vercel route needs **no service-role key** | from the connection row matching the public id + secret |
| Meta / WhatsApp webhooks | the web route verifies the provider **HMAC signature** (`X-Hub-Signature-256`, platform app secret) on the raw body, then calls `integration_receive_webhook` with the **gateway secret** (hash stored in `integration_gateway`) | from the **selected asset** (Page id / phone number id). A selected asset is globally unique, so one tenant cannot claim another's. Unknown assets are dropped. |
| Worker (Fly.io) | service-role key; claims events/requests with `FOR UPDATE SKIP LOCKED` | from the claimed row |

Provider tokens are encrypted **by the application** (AES-256-GCM, `INTEGRATION_ENCRYPTION_KEY` in the server env, never in the database) and stored as ciphertext in `integration_credentials`, which has no client grants. `secret_hash` is excluded from column grants. A database dump alone reveals no provider token.

Durability: webhook events are rows (`status`, `attempts`, `next_attempt_at`, `locked_until`); worker claims expire; transient errors retry with backoff (max 5) then dead-letter; delivery statuses never move a message backwards. Rate limiting is a database counter per connection (default 60/min, configurable) plus a brute-force throttle on bad credentials. Monitoring: connection health, 24h counts, `integration_errors`, `integration_sync_jobs`, and dead events are shown on the Connections page.

## Website Forms (fully implemented)

1. Connections -> Website Forms -> **Create connection**. Copy the webhook URL and the **secret (shown once)**.
2. Send submissions **server-to-server** (no CORS headers are sent, so a browser cannot post directly; never put the secret in browser JavaScript).

Credential: `Authorization: Bearer <secret>` (preferred) or `X-Optizen-Key: <secret>`. A `?key=<secret>` URL credential is **refused by default** (it leaks into server logs and browser history); the owner can enable it per connection ("Allow the credential in the URL") only for plugins that cannot send headers, such as Elementor's Webhook action. Responses carry `Referrer-Policy: no-referrer` and the endpoint never logs the URL. Body: `application/json` or `application/x-www-form-urlencoded` (nested `fields[email][value]` Elementor/PHP bodies are flattened), up to 20 KB / 60 fields. Optional `Idempotency-Key` header: retries with the same key never create a second lead; without a key an identical payload within 24h counts as a retry.

Responses: `201 {status:"created", lead_id}` · `200 {status:"duplicate"}` · `422 rejected` (no valid phone or email) · `400` bad body · `401` bad credential · `429` rate limited (`Retry-After`) · `503` retry.

```bash
curl -X POST "https://YOUR-APP/api/webhooks/forms/<public_id>" \
  -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" -H "Idempotency-Key: order-1001" \
  -d '{"name":"Asha Rao","email":"asha@example.com","phone":"+919845012345","message":"Interested in a demo","utm_source":"google","utm_campaign":"spring","page_url":"https://acme.example/contact"}'
```
```ts
// Next.js server action
await fetch(process.env.OPTIZEN_FORM_URL!, { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPTIZEN_FORM_SECRET}`, 'Content-Type': 'application/json', 'Idempotency-Key': submissionId }, body: JSON.stringify({ name, email, phone, message, utm_source }) });
```
```php
// WordPress (functions.php) for forms without a webhook add-on
wp_remote_post( 'https://YOUR-APP/api/webhooks/forms/<public_id>', [ 'headers' => [ 'Authorization' => 'Bearer <secret>', 'Content-Type' => 'application/json' ], 'body' => wp_json_encode( [ 'name' => $name, 'email' => $email, 'phone' => $phone, 'message' => $msg ] ) ] );
```
Elementor Pro: its Webhook action cannot set headers. Prefer posting from server code; if you must use it, enable URL credentials on the connection, then use `https://YOUR-APP/api/webhooks/forms/<public_id>?key=<secret>` (treat the URL as a secret and rotate it if it leaks).

Mapping: name/email/phone/message and common aliases (Your Name, Mobile, Contact Number, ...) map automatically; `utm_*`, `gclid`, `fbclid` are captured into `lead_attribution` with page URL, referrer and user agent (IP addresses are not stored). Use the mapping screen for other names; unmapped fields are appended to the lead summary and kept in `lead_attribution.extra`. An invalid phone/email is kept in the summary (the lead is still created if the other is valid); with neither, the submission is rejected and logged, never silently dropped. Each created lead emits `lead.created`, so existing automations (round-robin, follow-up task, notifications) run exactly as for manually created leads. Not yet supported: mapping into custom modules (leads only).

## Meta Lead Ads (adapter written; mocked-tested only)

Flow: OAuth (`/api/integrations/meta/start` -> Meta -> `/api/integrations/meta/callback`, CSRF-protected signed state + cookie nonce) -> long-lived token + Page tokens stored encrypted -> owner selects Pages -> Page subscribed to `leadgen` -> webhook (signature verified, routed by Page id, queued) -> worker fetches the lead with the Page token -> same mapping + CRM path as forms.
Requirements: Meta app with Webhooks + Lead Ads, Business Verification, **App Review** for `pages_show_list, pages_manage_metadata, pages_read_engagement, leads_retrieval, pages_manage_ads`; callback URL `https://YOUR-APP/api/webhooks/meta`, field `leadgen`. Env: `META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, INTEGRATION_ENCRYPTION_KEY, INTEGRATION_GATEWAY_SECRET, NEXT_PUBLIC_SITE_URL`. Until configured the card says "Setup required" and has no Connect button. Token expiry/revocation sets the connection to **Expired**.

## WhatsApp (adapters written; mocked-tested only)

`MessagingAdapter` (`src/lib/integrations/types.ts`) with `MetaCloudAdapter` and `InteraktAdapter`. The worker claims automation `integration_requests` (channel `whatsapp`) **only for organizations with a Connected WhatsApp connection**, sends the connection's **approved template** with the request message as body variable `{{1}}`, records the provider message id, and applies delivery statuses from signed webhooks (`/api/webhooks/whatsapp`, Meta Cloud only). Without a connection, template, phone country code or credentials nothing is sent: the request stays queued or fails with a clear error. Meta Cloud credentials are verified on save; **Interakt keys cannot be verified without sending** (explicit confirmation required, and Interakt delivery-status webhooks are not implemented). Other channels (sms, email, webhook) have no provider and are never claimed.

## Contract only: Google Ads, Telephony, Payments

Honest "Not connected" cards, no connect buttons. To add a provider: implement `LeadSourceAdapter` (incoming leads -> `IncomingLead` flat fields) or `MessagingAdapter`; route its webhook through a signature-verifying handler like `src/lib/integrations/webhooks.ts` into `integration_receive_webhook` (add the event kind and asset kind to its checks and the table constraints in a new migration); create leads only through `integration_submit` so CRM rules, attribution and `lead.created` stay uniform; classify provider failures with `ProviderError` so retry/dead-letter works.
- Google Ads: lead form extensions (webhook + key) and offline conversion upload (OAuth, developer token).
- Telephony: call events (answered/missed/recording) -> `lead_activities` + a `call.*` domain event.
- Payments: gateway webhook (HMAC) -> payment record + the contract trigger `payment.received` (currently draft-only in automations).

## Infrastructure and operations

1. Apply migrations 0005 -> 0008 before deploying this code. 2. Run `worker/integration-worker.mjs` (and `automation-worker.mjs`) on Fly.io: needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (worker only) and `INTEGRATION_ENCRYPTION_KEY` (same value as the web app). 3. One-time, with the service role or SQL editor: `select public.integration_set_gateway_secret('<same value as INTEGRATION_GATEWAY_SECRET>');`. 4. Webhook URLs must be public HTTPS; Meta retries non-2xx. 5. Payloads contain personal data: the worker purges processed payloads after 30 days (`integration_purge`). 6. Monitor dead events (`integration_webhook_events.status = 'dead'`), rate-limit 429s, and connections in Error/Expired.
