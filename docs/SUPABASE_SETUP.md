# Supabase setup and test workflow

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | app (`.env.local`) | Project API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app | Public anon key. Safe in the browser **only because** RLS + 0003 privileges restrict it |
| `NEXT_PUBLIC_SITE_URL` | app | Public origin, e.g. `http://localhost:3000`. Used for the email-link redirect |
| `SUPABASE_TEST_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | tests only (`.env.test.local`) | Disposable test project. The service-role key creates/deletes test users and is **never** read by the app |
| `SUPABASE_TEST_ALLOW_REMOTE=1` | tests only | Required to run against a non-local project |
| `APP_URL` | tests only | Running app for `app-routes.itest.mjs` |
| `ANTHROPIC_API_KEY` | app, **optional** | Enables AI-assisted setup (draft a configuration from a business description). Without it the app does not offer AI at all. Server-side only; never prefix with `NEXT_PUBLIC_` |
| `OPTIZEN_AI_MODEL` | app, optional | Model id for AI drafting (default `claude-sonnet-5-5`) |

The app does not use the service-role key. Keep it out of `.env.local`.

## A. Local stack (recommended for development and tests)

Needs Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
supabase init                      # once; creates supabase/config.toml, leaves migrations alone
supabase start
supabase db reset                  # applies supabase/migrations/0001..0006 in order
supabase status -o env             # API_URL, ANON_KEY, SERVICE_ROLE_KEY
```

In `supabase/config.toml` set `[auth] site_url = "http://localhost:3000"` and add `http://localhost:3000/auth/callback` to `additional_redirect_urls`. Local sign-in emails appear in the Mailpit/Inbucket UI (port 54324).

```bash
cp .env.example .env.local         # URL=API_URL, ANON key; SITE_URL=http://localhost:3000
cp .env.test.example .env.test.local   # fill in the three SUPABASE_TEST_* values from `supabase status`
```

## B. Hosted project

1. Create a project at supabase.com. Use a **separate** project for tests.
2. `supabase link --project-ref <ref>` then `supabase db push` (applies 0001-0006; never edit an applied migration, add 0007+).
3. Authentication → Providers: Email enabled. Authentication → URL Configuration: Site URL = your origin; Redirect URLs include `<origin>/auth/callback`.
4. Authentication → Settings: decide on "Confirm email" (magic-link sign-in works either way) and whether public signups stay open. `signInWithOtp` creates a user on first use; 0003 caps each user at 5 owned organizations.
5. Production email: Supabase's built-in SMTP is heavily rate-limited; configure a custom SMTP provider.
6. Copy Project URL and anon key from Project Settings → API into `.env.local`.

## Running the tests

| Command | Needs | What it runs |
|---|---|---|
| `npm test` | nothing | Unit tests + SQL policy tests (PGlite) |
| `npm run test:integration` | Supabase test project, plus the app running for `app-routes` | Live tests. **Exits 2 if credentials are missing; it never skips silently.** |

For the app-route tests: `npm run build`, start the app (`node .next/standalone/server.js` with `.next/static` and `public` alongside, or `npm run dev`) with `.env.local` pointing at the **same** project, then run the command. Set `SKIP_APP_TESTS=1` to run only the database tests.

## Manual checks not automated

- **Email-link callback success path** (PKCE code exchange): request a link on `/login`, open it from Mailpit, confirm you land on `/work` (or `/onboarding` for a new user). Automating this needs the PKCE verifier cookie from the same browser session.
- **Sign-out button** (server action): click it, confirm you land on `/login` and `/work` redirects there. The session revocation itself is tested live.


## Deploying 0005 (universal workspaces)

Apply `0005_universal_workspaces.sql` **before** deploying the app version that creates workspaces through `create_workspace`.
- It drops `create_organization`, so the previous app version cannot onboard new users after the migration runs (existing users and organizations are unaffected).
- The new app version cannot onboard before the migration runs (`create_workspace` does not exist yet).
- Order: apply migration, then deploy. Existing organizations keep their data and configuration; their legacy `industry_template` is kept and copied into `preset` for provenance.

## Deploying 0006 (custom modules)

Apply `0006_custom_modules.sql` **before** deploying the app version that has custom-module pages and the new Builder.
- It is additive (new `records` table, replaced/extended Builder functions, new indexes). Existing organizations, leads and configurations are untouched.
- The new app expects `record_create`, `record_update` and `restore_workspace_revision`; the previous app version keeps working against the migrated database except that Builder publishes now also enforce data protection.
- Requires 0005 (`create_workspace`, drafts). If 0005 has not been applied yet, apply 0005 then 0006 in order.
- Order: apply migrations, then deploy. Nothing else to configure; no new environment variables.

## Deploying 0007 (Automation Engine)

- Apply `0007_automation_engine.sql` after `0005` and `0006`. It is additive: new tables, new functions, `organization_members.active` (default true), two columns on `tasks`, and it marks all existing `domain_events` as processed so history never triggers new automations.
- The web app needs no new environment variables. Automations only run when the worker is running: see `docs/AUTOMATION.md` (service-role key goes on the worker only).

## Deploying 0008 (Integration Hub)

- Apply `0008_integration_hub.sql` after 0005-0007. Additive: 10 new tables, new functions, extra columns/status values on `integration_requests` (0007), no changes to earlier objects.
- Website Forms work with no new environment variables. Meta/WhatsApp need the variables listed in `docs/INTEGRATIONS.md`; register the gateway secret hash once with `integration_set_gateway_secret`.
- Run `worker/integration-worker.mjs` for Meta lead retrieval, WhatsApp sending and delivery statuses.

## Deploying 0009 (AI Assistant + hardening)

- Apply `0009_ai_assistant.sql` after 0005-0008. Additive: `lead_activities.seq`, six `ai_*` tables, `ai_tool_*` read functions, and replacements of three 0008 functions (`integration_submit`, `integration_ingest_form`, `integration_set_config`).
- Behaviour changes to know about: Website Forms now refuse `?key=` URL credentials unless the owner enables them per connection; invalid phone/email values are labelled "unverified" in the lead summary and the lead name is never derived from them.
- Set `ANTHROPIC_API_KEY` on the web app to turn the assistant on. Without it the panel is disabled and nothing is sent anywhere.

## Deploying 0010-0013 (Business Operations)

- Apply `0010` to `0013` in order after `0009`. 0010 runs `create extension if not exists btree_gist` (needed for the appointment overlap constraint). They add appointment, inventory and billing tables (all RLS, SELECT-only for clients), their `SECURITY DEFINER` write functions, `ai_tool_*` read functions, and replace `automation_validate`, `automation_publish`, `automation_context` (from 0007) and wrap the workspace validator / data-protection check.
- All modules are OFF until an owner enables them in Builder -> Business operations and publishes. No environment variables are needed.
- Behavior change: automations on `appointment.created` and `payment.received` are no longer refused as "not available yet"; they are refused only while the matching module is disabled.

## Deploying 0014-0016 (Permissions, Analytics, Operations fixes)

- Apply `0014`, `0015`, `0016` in order after `0013`. 0014 adds restrictive RLS policies and write-guard triggers to many existing tables: it does not change what members WITHOUT a custom role can do, but test it against a copy of production first. 0014/0015 replace `integration_admin`, `automation_publish`, `automation_execute`, `ai_set_proposal_status` and `ai_create_proposal` with versions that add checks.
- No new environment variables. Nothing is applied to production by the repository.

## Deploying 0017 (Visual Builder, contact privacy)

- Apply `0017_visual_builder.sql` after `0016`. It adds `automation_layouts`, wraps the workspace-definition validator, **replaces** `publish_workspace_config`, `crm_set_stage`, `crm_update_lead`, `ai_tool_get_lead` and `role_validate`, rebuilds the `crm_lead_list` view, and **revokes `select` on `contacts.phone` / `contacts.email` from `authenticated`**.
- Before applying to production: any custom SQL, BI tool, or script that connects as `authenticated` (not the service role / postgres) and reads those two columns will start failing with `permission denied`; point it at `crm_lead_list` instead. The Optizen app itself is updated. Try it on a copy first.
- Fonts for invoice PDFs ship in `assets/fonts` (no network at runtime). Self-hosted deployments need that directory next to the app (the standalone build includes it).

## Deploying 0018 (AI engine, sensitive-field privacy)
- Apply `0018_ai_engine.sql` after `0017`. It adds usage reservations, request idempotency, plans, unfinished-workflow storage, and **revokes client `select` on `records.data`, `records.search_text` and `invoices.snapshot`**, and rewrites `analytics_source_info` and `ai_tool_list_module_records` to read `records_view`. Custom SQL/BI tools connecting as `authenticated` that read those columns must use `records_view` / `invoice_snapshot()`. Try it on a copy first.
- Optional environment: `OPENAI_API_KEY` (or `OPTIZEN_SPEECH_API_KEY`) enables voice input; `OPTIZEN_SPEECH_MODEL`, `OPTIZEN_SPEECH_BASE_URL` override defaults.

- Task 14: apply `0019_user_experience.sql` after 0018. It adds invitations, profiles, notification preferences/categories, notification triggers, `home_summary()` and `global_search()`. No environment variables are needed; invitations are shared as links (no email is sent). Browser tests: `npm run build && npm run test:browser` (needs `npx playwright install chromium`).

## Deploying 0020 (Reliability, reminders, payments foundation)

- Apply `0020_reliability.sql` after 0019. **Do not apply it to the hosted project without approval.** It is additive: heartbeat, reminder, consent, outbound-log and payment-gateway tables, the restricted `optizen_worker` role, replacements of the integration worker functions (consent gate, at-most-once claims), `maintenance_tick`, `reminders_process`, and the payment gateway functions. It also changes behaviour: WhatsApp messages are only claimed for contacts with a recorded opt-in, and a send that was interrupted is marked *Delivery uncertain* instead of being retried.
- Web app: no new required variables. Payments webhooks reuse `INTEGRATION_GATEWAY_SECRET` and `INTEGRATION_ENCRYPTION_KEY`.
- Workers: replace `SUPABASE_SERVICE_ROLE_KEY` with `WORKER_JWT` + `SUPABASE_ANON_KEY` (see `docs/WORKERS.md`). Deploy `fly.worker.toml` (three process groups); the old `worker/fly.toml` was removed.
- Order: apply the migration, then deploy the web app, then the workers. Rolling back the web app alone is safe; rolling back the workers to the old image would bypass the consent gate, so do not.
