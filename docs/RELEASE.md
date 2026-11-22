# Release checklist, migration compatibility, rollback and recovery

Applies to a controlled pilot on a **separate staging project first**, then production. Nothing here is run automatically. Do not apply migrations to, or deploy against, the existing production-labelled Supabase project without explicit approval.

## 1. What is being released
Branch `feature/task-15-integrations-reliability` (local, not pushed). Migrations `0001` → `0027`, contiguous and in order. `0001_foundation_DRAFT.sql` keeps its historical name: **do not rename it** (a renamed file looks like a new migration to the Supabase history table).

| # | Purpose | Compatibility note |
|---|---|---|
| 0001–0004 | foundation, onboarding, hardening, CRM engine | base |
| 0005–0006 | universal workspaces, custom modules | additive |
| 0007 | automation engine | additive; marks existing events processed |
| 0008–0009 | integration hub, AI assistant | additive; 0009 refuses `?key=` URL credentials unless enabled |
| 0010–0013 | appointments, inventory, billing, automation/AI hooks | additive; needs `btree_gist` |
| 0014–0016 | permissions/branches, analytics, fixes | additive |
| **0017** | visual builder; **revokes direct `SELECT` on `contacts.phone/email`, recreates `crm_lead_list`** | **BREAKING for app versions older than Task 12**: they read those columns directly |
| 0018–0019 | AI engine, user experience (invitations, search, notifications) | additive |
| **0020** | reliability: worker role, heartbeats, consent, reminders, at-most-once delivery, payment gateway foundation | **Behaviour change**: WhatsApp is sent only to opted-in contacts; interrupted sends become *Delivery uncertain*. An **old worker image would bypass the consent gate: never roll workers back below this release** |
| 0021 | payment idempotency race fix (function replaced) | compatible (same signature/results for non-racing calls) |
| 0022 | revokes execute on internal/trigger functions | compatible; `notif_enabled` no longer callable by browsers |
| 0023 | credential re-key function, key-version counts | additive; worker/service roles only |
| 0024 | trigger: a payments connection becomes Connected only after a verified notification | behaviour change; no earlier UI could connect payments |
| 0025 | `worker_health_check` for uptime monitors | additive; gateway-secret gated |
| 0027 | explicit privileges for `service_role` (hosted Supabase no longer grants them by default) | additive; no new access for anon/authenticated/worker |
| 0026 | search/home-summary performance (same signatures and output; new `search_candidates`) | compatible; proven identical by 265 role/query comparisons in `test:perf` |

**Application versions:** the web app and workers of this release require migrations through `0026`. The previous web version works against `0026` except for the 0017 caveat above (only relevant if you skip releases). Deploy order: **migrations → web app → workers**.

## 2. Pre-release checklist (all must be true)
- [ ] `git status` clean on the release commit; `git log` reviewed; branch not yet merged to `main`.
- [ ] `npx tsc --noEmit`, `npm test`, `npm run test:concurrency`, `test:security`, `test:workers`, `test:perf`, `npm run build`, `npm run test:browser` all green on that commit.
- [ ] Secret scan of the tree and full history clean (no keys, no `.env*`, no generated files tracked). Last scan: clean.
- [ ] `.env.example` lists every variable the code reads (platform variables such as `PORT`, `NODE_ENV`, `FLY_*` excepted).
- [ ] Staging project created per `docs/STAGING.md`; migrations applied there first; the five catalog queries pass.
- [ ] `npm run test:integration` and `npm run test:e2e:staging` green **against staging**.
- [ ] Staging drills done: worker kill/restart, worker token renewal, key rotation, backup restore (section 4).
- [ ] Production: a backup/PITR point is confirmed **immediately before** applying migrations (section 3); on-call owner named; maintenance notice sent.
- [ ] Provider approvals tracked in `docs/PROVIDERS.md` are either granted or the dependent feature is switched off for the pilot.

## 3. Rollback strategy
Migrations are **forward-only**. The rollback tool for the database is a restore; for everything else it is a redeploy.

| Layer | Rollback | Notes |
|---|---|---|
| Web app (Vercel) | redeploy the previous build (instant) | safe against `0026` (see section 1) |
| Workers (Fly) | `fly releases` then `fly deploy --image <previous>` | **do not go below the 0020 worker image** (consent gate) |
| Database, last migration only | the reversal snippets below | safe because 0021–0026 are small and independent |
| Database, anything larger | **restore** from the PITR/backup point taken before the release, then redeploy the previous app + workers | data written after that point is lost: decide knowingly; export it first if needed |

Reversal snippets (run in the SQL editor, newest first, only if the corresponding migration caused the problem):
```sql
-- 0026: restore the 0019 definitions of global_search and home_summary (copy the two `create or replace function` blocks from 0019_user_experience.sql), then:
drop function if exists public.search_candidates(uuid, text, text, text, boolean, integer);
-- 0025
drop function if exists public.worker_health_check(text);
-- 0024
drop trigger if exists integration_payments_evidence on public.integration_connections; drop function if exists public.payments_require_evidence();
-- 0023
drop function if exists public.integration_rekey_credential(uuid, text, text, integer), public.integration_key_versions();
-- 0022 (only if something unexpectedly needed these; re-grants the previous, broader access)
grant execute on function public.notif_enabled(uuid, uuid, text) to authenticated;
-- 0021: re-create billing_post_payment from 0012_operations_billing.sql (it differs only by the re-check after the invoice lock)
```
Feature switches that need no deploy: turn reminders off (Appointments → setup), disconnect WhatsApp/payments (Builder → Connections), stop a worker group (`fly scale count <group>=0`; work queues safely).

## 4. Backups and restore (rehearse before the pilot)
- **Hosted (Supabase):** enable daily backups and, for the pilot, **Point-in-Time Recovery** (paid add-on). Confirm retention covers your recovery objective. Restores are performed from the dashboard (Database → Backups) into the same project, which overwrites it; for a drill, restore into a **new project** instead.
- **Logical dumps** (extra safety, off-platform): `supabase db dump --linked -f backup.sql` (schema) and `--data-only`; store encrypted. Credentials inside dumps are still encrypted with `INTEGRATION_ENCRYPTION_KEY`: keep that key (and old versions) in a separate vault, otherwise restored connections must be reconnected.
- **What was rehearsed here** (`npm run test:perf`, real PostgreSQL 18): a file-level backup of a 20,000-lead database restored into a new server kept every row, policy, function and index, the money balances and idempotency keys; row-level security and table privileges were intact; the restored database accepted new work. A SIGKILL of the database in the middle of a payment storm lost none of the 8,923 acknowledged payments and left every invariant (payment ↔ ledger ↔ audit) intact. Practical detail learned: a restored data directory must be mode `0700` or PostgreSQL refuses to start.
- **Restore drill checklist (staging):** restore the latest backup into a scratch project → run the five catalog queries (`docs/STAGING.md`) → sign in as a test user → confirm leads, invoices and balances → mint a worker token with that project's JWT secret → confirm workers report → delete the scratch project. Record date, duration, and who did it.
- **After any restore:** workers re-run safely (queues and leases live in the database; WhatsApp messages in flight become *Delivery uncertain* rather than being repeated). Re-register the gateway secret if the restore predates it.

## 5. Monitoring and alerts
| Signal | How | Alert when |
|---|---|---|
| Web app up | `GET /api/health` (200) | non-200 for 2 min |
| Workers reporting | `GET /api/health/workers` with `Authorization: Bearer $OPS_HEALTH_TOKEN` | 503 (names the stale or missing worker) |
| Each worker alive | Fly check on `:8080/healthz` | Fly restarts automatically; alert on repeated restarts |
| Worker token expiry | Builder → Operations warns < 30 days | calendar reminder at 60 days |
| Dead-lettered work, uncertain WhatsApp sends, held payments, expired connections | Builder → Operations → *Needs a person* | check daily during the pilot |
| Database | Supabase dashboard: CPU, connections, disk, slow queries | per your thresholds |
Limitation: the Operations page cannot report that the whole database is unreachable; use the uptime monitor.

## 6. Rate limits and abuse controls (what exists)
Website form endpoint: per-connection limit (default 60/min, 1–600, configurable), 20 KB body, 60 fields. Failed gateway-secret attempts are counted globally. Invitations: at most 50 pending per workspace, 1–30 day expiry, single use. AI: per-workspace daily token cap, per-user hourly message cap, monthly cap, reservation before every call. Sign-in e-mail: Supabase Auth platform limits (configure SMTP for staging/production). Webhooks (Meta, WhatsApp, Razorpay): signature verified before any work; replays are idempotent.

## 7. Go / no-go for the controlled pilot
See the recommendation at the end of the Task 16 report. In short: **GO for a staging rehearsal now; CONDITIONAL GO for a production pilot** once the staging evidence in `docs/STAGING.md` section 6 exists and the provider approvals for the features you enable are granted.
