# Operations runbook (staging and the controlled pilot)

Audience: the person on call for the pilot. Everything here is a procedure that exists in the repository; where something has only been rehearsed locally it says so.

## 1. Where to look
| Question | Look at |
|---|---|
| Is the web app up? | `GET /api/health` → `{"ok":true}` |
| Are all background workers reporting? | `GET /api/health/workers` with `Authorization: Bearer $OPS_HEALTH_TOKEN` (200 / 503 naming the stale worker); Builder → **Operations** |
| What is stuck and needs a person? | Operations → *Needs a person* (dead automation runs, failed leads, undelivered WhatsApp messages, held payments) |
| Did a provider connection break? | Operations → *Connection status*; Builder → Connections |
| What did a worker do? | Fly logs for the machine (JSON lines: ids and error classes, never message text, numbers or tokens) |
| Did anyone change something sensitive? | `audit_events` (payments, credentials re-keyed, settings) |

## 2. Daily check during the pilot (5 minutes)
1. Both health endpoints green. 2. Operations: no *Needs a person* items older than a day; no worker token warning. 3. Delivery uncertain messages: check the customer chat before pressing *Send again*. 4. Held payments: fix the cause (wrong invoice, currency, over-payment) then *Retry*, or record manually. 5. Supabase dashboard: disk, CPU, connections, backups succeeded.

## 3. Incident playbooks
| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health/workers` is 503 | a worker crashed, was redeployed, or its token expired | Fly: `fly status -c fly.worker.toml`; `fly logs`; restart the group. If logs say token expired/invalid: mint and set a new token (`docs/WORKERS.md`). Work is queued safely and resumes; nothing is lost or repeated. |
| Automations not running, workers healthy | the workflow is disabled or runs are dead-lettered | Operations → Retry the dead runs; Automations → check *enabled*. |
| Leads from a website form missing | wrong secret (`401`), no phone/email (`422`), rate limit (`429`) | Connections → the form card → *Last problem*; `docs/WEBSITE_FORMS.md` troubleshooting table. |
| Meta leads stopped | token expired / permission removed (190, 10, 200–299) / Page access lost (458, 492) | Connections shows *Expired*; reconnect Meta and re-select the Page; Operations → Retry each failed lead. |
| WhatsApp failures | template not approved (132001), customer opted out (131050), pair rate limit (131056), number not registered (133010) | Fix at the provider; consent changes are recorded automatically; *Send again* only after the cause is fixed. |
| Payment shows as held | over-payment, currency mismatch, unknown invoice, connection not active | Operations → read the reason → fix → Retry. Never record the same payment manually *and* retry it. |
| A customer got a message twice | should be impossible (unique keys, at-most-once delivery) | Preserve `outbound_message_log` for that request and escalate as a defect. |
| Sign-in e-mails not arriving | SMTP/rate limit | Supabase Auth logs; check SMTP provider; as an emergency, an owner can add a user through the Supabase dashboard. |
| Database slow | a missing index or a runaway query | Supabase → Query performance; compare with `npm run test:perf` figures; add an index by a new migration. |
| Suspected credential leak | any provider token, the encryption key, the worker token, the service-role key | Provider: revoke/rotate at the provider first. Encryption key: `docs/KEY_ROTATION.md`. Worker token: mint a new one, set it, let the old expire (or rotate the JWT secret to kill it now). Supabase keys: rotate in the dashboard, update Vercel/Fly, redeploy. Record it in the deployment record. |

## 4. Routine procedures
- **Deploy** (staging or production): `docs/RELEASE.md` §2–3 and the deployment record. Order: migrations → web → workers.
- **Rotate the worker token:** `docs/WORKERS.md` ("Renewal"). Rehearse once on staging.
- **Rotate the encryption key:** `docs/KEY_ROTATION.md`. Rehearse once on staging.
- **Restore a backup:** `docs/RELEASE.md` §4 (drill into a scratch project, never over live data without sign-off).
- **Switch a feature off without a deploy:** reminders (Appointments → setup), WhatsApp/payments (Connections → Disconnect), stop a worker group (`fly scale count <group>=0`).

## 5. Roles and contacts (fill in before the pilot)
Pilot owner: ____ · On call: ____ · Supabase admin: ____ · Vercel/Fly admin: ____ · Provider contacts (Meta, Razorpay): ____ · Escalation path and response times: ____
