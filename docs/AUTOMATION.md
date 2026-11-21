# Automation Engine

Optizen automations let owners/admins automate routine work without code: **trigger -> conditions -> ordered actions**. The same engine runs for every workspace and custom module. Migration: `supabase/migrations/0007_automation_engine.sql`.

## How it works

```
domain_events (outbox, 0004)  --automation_dispatch-->  automation_runs (durable queue)  --automation_execute-->  automation_steps (history) + real effects
```

* Everything is a row in Postgres: events, runs, delayed actions, retries, the round-robin cursor. **There are no in-memory timers.** The worker only calls `automation_tick()` in a loop, so a restart or a second copy loses/duplicates nothing.
* **Dispatch** claims unprocessed events (`FOR UPDATE SKIP LOCKED`), matches enabled workflows of the *same organization* whose published version was enabled before the event, evaluates the conditions on a snapshot of the lead/task/record, and creates one run per workflow per event (unique `(workflow_id, event_id)` = idempotent). Events that existed before migration 0007 are marked processed and never trigger workflows.
* **Execute** runs the steps in order. Each step is recorded in `automation_steps`. `wait` parks the run (`waiting`, `next_attempt_at`) and the worker resumes it when due.
* **Retries**: transient errors (deadlock, timeout, lock) retry with exponential backoff (1, 2, 4, 8 min), at most 5 attempts. Permanent errors (validation, permission, not found) and exhausted retries go to `dead` (dead-letter). Owners/admins can **Try again** from the log.
* **Idempotency**: unique `(run, step)` on steps, notifications, integration requests and automation-created tasks; an open task with the same title/lead/owner is not duplicated.
* **Loop prevention**: events emitted by automations carry `payload.automation {run_id, depth, chain}`. A workflow already in the chain, or a chain deeper than 3, is recorded as a `skipped` run.
* **Round robin**: per workflow cursor (`automation_rotation`), locked `FOR UPDATE` while choosing, ordered by user id. Eligible = current members with the chosen roles and `active = true`. Removed members vanish from the candidate list; deactivated ones (Team page) are skipped.
* **Security**: workflows are JSON validated against a fixed grammar (`automation_validate`, mirrored in `src/lib/automation/validate.ts`); there is no SQL, code or expression language. A run acts as the person who published that version and is refused if they are no longer an active owner/admin. Record updates go through the module's field validation. Worker functions are granted to `service_role` only. Only owners/admins read workflows and logs; notifications are private to the recipient.

## Catalog

Triggers: `record.created`, `record.updated` (optionally for one module), `lead.created`, `lead.assigned`, `task.created`, `task.completed`; operations triggers (published only while the module is enabled, see docs/OPERATIONS.md): `appointment.created|rescheduled|cancelled|completed`, `inventory.low_stock|stock_received|stock_adjusted|stock_consumed|stock_transferred`, `invoice.created|issued|paid`, `payment.received|refunded`, `credit_note.issued`.
Conditions (combined with AND or OR): equals, not equals, contains, empty, not empty, greater, less, before, after (dates as `YYYY-MM-DD` or `today`). Fields: `lead.*` (stage, source, summary, assigned_to, full_name, phone, email, created_at), `task.*` (title, status, owner_id, due_date, outcome), `record.<field key>`.
Actions: round-robin assign, assign to a person, create follow-up task (`due_in_days`, owner = lead assignee or a person), update task status, update a record field, notify a team member in Optizen, wait (minutes or until a date field), request an external message.
Templates: `{{lead.full_name}}`, `{{task.title}}`, `{{record.<key>}}` in text fields.

External messaging: `request_integration` only writes a row to `integration_requests` with status `requested` and `provider = null`. **Nothing is sent.** A future provider adapter will claim those rows; no WhatsApp/Meta/Google credentials are needed or used.

Known limits: conditions use the data at event time (actions re-read the live lead/task); due dates use the database's UTC date; `update_record` targets the triggering record only; events older than the migration or created while a workflow was disabled never run.

## Infrastructure required before automations run in production

1. **Apply migrations `0005`, `0006`, `0007`** (in order) before deploying the app that contains this code.
2. **Run the worker** (the app does not process automations itself). `worker/automation-worker.mjs` needs Node 22, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (**service-role key: set it only on the worker, never in the web app/Vercel project**). Optional: `AUTOMATION_POLL_MS` (default 5000), `AUTOMATION_BATCH` (default 20). Run several copies for throughput; they coordinate through the database.
   * Fly.io: `fly launch --no-deploy`, set the secrets with `fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...`, build with `worker/Dockerfile` (`fly deploy --config worker/fly.toml --dockerfile worker/Dockerfile`; run from the repo root). One always-on machine, no HTTP service. Review both files before first use: they have not been deployed.
   * Alternative: a scheduler (cron, GitHub Actions, Supabase cron + Edge Function) running `node worker/automation-worker.mjs --once` every minute; delays then have up-to-a-minute granularity.
3. Make sure the Supabase project's statement timeout allows a tick (default batches are small).
4. Monitor `automation_runs` with `status = 'dead'` (shown as Failed in the UI) and the age of the oldest `queued`/`waiting` run past its `next_attempt_at`.

Until the worker is running, enabled automations simply queue; no data is changed.

## Tests

`npm test` runs `tests/automation.test.mjs` against real PostgreSQL (PGlite) with migrations 0001-0007: trigger matching, every condition operator, AND/OR, round robin (cursor, wrap-around, inactive/removed members), idempotency, delayed execution, retries/backoff/dead-letter/requeue, cross-organization isolation, permissions, loop prevention, TS/SQL validator parity. PGlite has a single connection, so **true parallel workers are only exercised by `tests/integration/automation.itest.mjs`** against a live (local) Supabase project (`npm run test:integration`).
