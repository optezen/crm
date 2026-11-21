# Provider integrations: credentials, approvals and what is verified

Status key: **Offline-tested** = real PostgreSQL (PGlite) and mocked HTTP in `npm test`. **Not live-tested** = no real provider account has been contacted. Provider behaviour below was checked against Meta's public documentation on 2026-11-21; re-check before going live because Meta changes versions and policies.

## Meta Lead Ads (Facebook / Instagram instant forms): offline-tested, not live-tested
- **Needed:** a Meta app (App ID/secret), the Webhooks product, **Business Verification**, and **App Review (Advanced Access)** for `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `leads_retrieval`, `pages_manage_ads`. Until approved, only people with a role on the app can connect, which is enough for a test with your own Page.
- **Web app env:** `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `INTEGRATION_ENCRYPTION_KEY`, `INTEGRATION_GATEWAY_SECRET`, optional `META_GRAPH_VERSION` (default `v26.0`, the newest listed on 2026-11-21).
- **Callback URL:** `https://YOUR-APP/api/webhooks/meta`, field `leadgen`. Signature (`X-Hub-Signature-256`) is verified with the app secret; unsigned traffic is never accepted.
- **Flow:** OAuth with signed state → long-lived token → Pages list → administrator selects Pages → Page subscribed to `leadgen` → webhook → worker fetches the lead with the Page token. A connection is *Connected* only after Meta accepted the credentials and at least one Page subscription succeeded; the selection is rolled back if Meta refuses.
- **Failures (classified, surfaced in Connections and Operations):** 190 (+ subcodes 458 app removed, 459/464 account checkpoint, 460 password changed, 463 expired, 467 invalid, 492 lost Page role) → connection *Expired*, leads dead-lettered with a plain instruction to reconnect; 4/17/32/341/613 throttling → retried with backoff; 10 and 200–299 permission missing/removed → reconnect and re-approve; 5xx/1/2 → retried. Removing the app from a Page ends events; the next fetch reports 458.
- **Version:** v21.0 is documented as supported until 2027-01-21. Upgrading the version means re-running `tests/providers.test.mjs` and `tests/integrations-adapters.test.mjs`.
- **Operator note:** Page access tokens derived from a long-lived user token do not expire by time but stop working on password change, role loss or app removal. Plan for reconnects.

## WhatsApp: offline-tested, not live-tested
Two providers behind one contract (`MessagingAdapter`).
- **Meta WhatsApp Cloud API:** needs a WhatsApp Business Account, a registered phone number, a permanent access token (system user) and **approved message templates**. Business-initiated messages outside a 24-hour customer window can only be templates; the worker never sends free text. Webhook: `https://YOUR-APP/api/webhooks/whatsapp` (same signature scheme as Meta Lead Ads), subscribe to `messages`. Delivery `sent/delivered/read/failed` events update the request; they never move a message backwards.
- **Interakt:** API key; sending works, delivery-status webhooks are **not implemented** (status stays *sent*).
- **Consent:** nothing is sent unless the contact has a recorded opt-in (`messaging_consent`, with source and an audit log). Error `131050` (customer stopped messages from the business) records an opt-out. Opt-out cancels queued messages. Consent is recorded on the lead page (WhatsApp consent card) through `consent_set`: owners, admins, managers and employees who can already see that contact; an opt-in needs a confirmation and a note saying how the customer agreed; opt-outs need neither; history is shown. Opt-outs from WhatsApp itself (error 131050) are recorded automatically.
- **Template rules:** a connection stores the template name and language. Reminders use their own approved template. Template body variables are positional text; a parameter-count mismatch (132000) or unapproved/missing template (132001) is a permanent, visible failure.
- **Never real in tests:** offline tests mock HTTP; no message is ever sent by `npm test`.
- **Duplicate protection:** per-request unique keys, at-most-once delivery (see WORKERS.md), and the request id is sent as `biz_opaque_callback_data` so an uncertain send can be reconciled from the status webhook.

## Appointment reminders: offline-tested
Settings (Work → Appointments → setup, owners/admins; managers see a read-only summary): on/off, offsets (default 24 h and 1 h before), staff and/or customer audience, template + language, quiet hours (wrapping windows supported). All times use the organization's time zone. Staff get an in-app notification; customers get a WhatsApp template only with a connected provider, an approved template, a phone number and recorded consent. The customer message carries only the appointment type name and local date/time: never notes, staff names or internal details. Without a suitable provider the customer reminder is *skipped with the reason*, never faked. Cancelling or rescheduling an appointment cancels pending reminders and creates new ones; reminders already sent are not repeated.

## Notifications
In-app notifications need no provider and always work. Email/push/SMS are not implemented, and the interface says "In-app only" rather than implying otherwise.

## Payments: foundation, offline-tested, no gateway connected
- **Implemented:** a gateway adapter contract (`src/lib/payments/gateway.ts`), a Razorpay adapter (HMAC-SHA256 `X-Razorpay-Signature` over the raw body, per-connection secret stored encrypted), a webhook route `https://YOUR-APP/api/webhooks/payments/<public_id>`, durable event storage with duplicate protection (event id and provider payment id), application through the same posting function as manual payments (partial payments, balance, currency and over-payment checks), a **held** state with a reason and a reconciliation report separating gateway from manual payments. A payment is recorded only from a verified signature **and** a matching open invoice.
- **Connecting (Builder → Connections → Payments):** an owner/admin creates the connection, copies the webhook URL into Razorpay, pastes the webhook secret (stored encrypted, never shown again), sends one test payment, and can press **Activate** only after a correctly signed notification has been received (enforced by the database, migration 0024). Held payments appear in Operations with Retry. Refunds are stored but never reverse money automatically. Payment *initiation* (checkout/payment links), Stripe and other gateways, and GST/e-invoice rules are out of scope.
- **Needs for live use:** a Razorpay account with webhooks enabled for `payment.captured` (the invoice id in `notes.invoice_id` must be set when the payment is created), `INTEGRATION_GATEWAY_SECRET` registered, and the worker running.
- **Razorpay amounts** are in the smallest currency unit; only currencies with two decimals (and INR) are accepted. Anything else is held, never guessed.

## Website Forms: implemented and offline-tested
See WEBSITE_FORMS.md.

## Approval and account checklist for a live pilot
1. Supabase project with migrations through 0020 applied (needs your approval to run).
2. Workers deployed with `WORKER_JWT` and `INTEGRATION_ENCRYPTION_KEY`.
3. Web app env set (see `.env.example`); gateway secret registered once.
4. Meta: app in Live mode, Business Verification, App Review for the listed permissions (days to weeks).
5. WhatsApp: WABA + number + approved templates + system-user token; test with your own number first.
6. Razorpay (optional for the pilot): account, webhook secret, test-mode first.
7. Uptime monitoring on `/healthz` and an on-call owner for dead-lettered items.
