# Background workers: setup, credentials, scaling, deployment, recovery

Nothing in this repository deploys anything. Every command below is run by an operator, on purpose.

## What runs, and why it is separate
The web app (Vercel) answers requests. Three small always-on processes do the work that must not depend on a visitor:

| Process | File | Poll | Does |
|---|---|---|---|
| `automation` | `worker/automation-worker.mjs` | 5 s | runs automation workflows (`automation_tick`): steps, waits, retries, dead-letter |
| `integrations` | `worker/integration-worker.mjs` | 5 s | fetches Meta leads, sends approved WhatsApp templates, applies delivery statuses, applies verified gateway payments |
| `maintenance` | `worker/maintenance-worker.mjs` | 60 s | overdue follow-up notifications (once per task per day), appointment reminders, flags uncertain sends, purges old payloads/logs |

All three are **stateless**. All queue state, leases, retries and counters live in Postgres, so any process can be killed and restarted at any moment. `maintenance_tick` runs under an advisory lock, so extra copies simply do nothing.

## Delivery guarantees (what a restart can and cannot do)
- **Automation runs, incoming leads, status events:** leased and retried with backoff; every effect is idempotent (unique keys), so a crash re-runs safely. After the maximum attempts an item is *dead-lettered* and shown in Builder → Operations → *Needs a person*.
- **WhatsApp sends are at-most-once.** A message the worker claimed but never finished is **never re-sent automatically**, because the provider may already have delivered it. It is marked *Delivery uncertain*. If the provider later reports that message (delivery webhooks echo our request id in `biz_opaque_callback_data`), it is reconciled automatically. Otherwise an administrator decides to *Send again*. Duplicate sends cost customer trust; a delayed message does not.
- **Reminders** are rows in `appointment_reminders` (unique per appointment, time, offset and audience). Rescheduling cancels pending rows and creates new ones; a row that was sent is never sent again.
- **Payments:** an event is stored once and applied through the same function manual payments use; a held payment is never forced.

## Credentials (least privilege)
| Secret | Where | Notes |
|---|---|---|
| `SUPABASE_URL` | workers | project URL |
| `SUPABASE_ANON_KEY` | workers | public key; only identifies the project |
| `WORKER_JWT` | workers | long-lived token for the restricted Postgres role `optizen_worker`. It can call the worker functions and read **encrypted** credential blobs; it cannot read tables, bypass row security or touch other data |
| `INTEGRATION_ENCRYPTION_KEY` | workers **and** web app | 32 random bytes, base64 (`openssl rand -base64 32`). Decrypts provider tokens in memory. Losing it means every provider connection must be reconnected; rotating it needs a re-encrypt step (not yet scripted) |
| `SUPABASE_SERVICE_ROLE_KEY` | **not needed.** Works as a fallback (logged as a warning), never set on the web app |

Mint the token once, on an operator machine (never in CI logs):
```bash
SUPABASE_JWT_SECRET='<project JWT secret>' node worker/mint-worker-token.mjs 365   # valid 365 days
```
Revoke by rotating the project JWT secret (this also signs everyone out of the app, so schedule it) or by revoking the role's grants. Put a calendar reminder to mint a new token before it expires; an expired token shows up as workers that stop reporting.

## Deploy on Fly.io
Prerequisite: migrations through `0020` are applied to the target Supabase project (see SUPABASE_SETUP.md).
```bash
fly apps create optizen-workers                                   # once; name is in fly.worker.toml
fly secrets set -c fly.worker.toml SUPABASE_URL=... SUPABASE_ANON_KEY=... WORKER_JWT=... INTEGRATION_ENCRYPTION_KEY=...
fly deploy -c fly.worker.toml --build-only                        # review the image first
fly deploy -c fly.worker.toml
fly scale count automation=1 integrations=1 maintenance=1 -c fly.worker.toml
```
Each process listens on `:8080/healthz`; it answers 503 when it has not completed a tick recently or has failed 8 times in a row, and Fly restarts it. Optional tuning: `AUTOMATION_POLL_MS`, `INTEGRATION_POLL_MS`, `MAINTENANCE_POLL_MS`, `AUTOMATION_BATCH`.

Any container host works (`docker build -f worker/Dockerfile .`, then run with a different command per process). `node worker/<name>-worker.mjs --once` runs a single tick and exits, which suits a cron-style host.

## Scaling
One copy of each is enough for a pilot. `automation` and `integrations` may run several copies: rows are claimed with `FOR UPDATE SKIP LOCKED`, so copies never take the same item. Scale `integrations` first if WhatsApp or Meta backlog grows while workers are healthy (the provider is rate limiting: check Operations before adding copies). Keep `maintenance` at 1 (more is harmless, not useful). Throughput limits to know: WhatsApp Cloud API per-number throughput, Meta Graph rate limits, Supabase connection limits (each worker uses short requests, not long-lived connections).

## Health and monitoring
- **Builder → Operations** (owners/admins): each worker's heartbeat (a worker is *Not reporting* after 2 minutes), queue backlog and oldest due automation run, dead-lettered items with a Retry button, uncertain WhatsApp sends, connection status and recent secret-free errors.
- Heartbeats carry counters and an error **class** only (never data). Logs are JSON lines; they contain ids and error classes, no message text, phone numbers or tokens.
- External monitoring: point an uptime check at each machine's `/healthz` (Fly does this), and alert if *no* worker has reported for > 5 minutes. The Operations page cannot warn you if the whole database is unreachable.

## Failure recovery runbook
| Situation | What happens | What you do |
|---|---|---|
| Worker crashes / is redeployed | work is leased; leases expire; items are retried. WhatsApp sends in flight become *Delivery uncertain*. | Nothing for automations/leads. Review *Delivery uncertain* messages in Operations; check the customer chat, then *Send again* only if it was not delivered |
| All workers down | queues grow; nothing is lost. Overdue alerts and reminders resume on return (a reminder that is late is still sent while the appointment has not started; once it has started the reminder is skipped with that reason) | restart workers; confirm heartbeats in Operations |
| `WORKER_JWT` expired/invalid | workers fail every tick; heartbeats stop (the heartbeat uses the same token) | mint a new token, `fly secrets set WORKER_JWT=...` |
| Meta token expired/revoked, Page access lost | the connection turns *Expired*/*Error*; lead events fail non-retryably | Connections → reconnect Meta and re-select the Page; Operations → *Needs a person* → Retry each failed lead |
| WhatsApp template rejected/unapproved (132001), quota or restriction | message fails with the provider's reason | fix the template in Meta Business Manager, then *Send again* |
| Customer sent STOP / error 131050 | the customer is recorded as opted out; nothing further is sent | none; consent can only be re-granted by a person with a recorded source |
| Payment held | nothing is posted; reason shown | fix the cause (wrong invoice, currency, over-payment), then Retry; or record it manually |
| Bad deploy | `fly releases` then `fly deploy --image <previous>` | the database functions are backwards compatible within a task's migrations |
| Duplicate suspected | idempotency keys, unique indexes and at-most-once sends prevent it by design | check `outbound_message_log` (Operations → Recent WhatsApp activity) |

## Data retention
Processed webhook payloads are purged after 30 days, worker heartbeats after 7, the AI request log after 2, and the outbound message log (no message text, no numbers) after 180 days, by `maintenance_tick`.
