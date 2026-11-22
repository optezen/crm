# Known defects and limitations

Status as of the Task 17 deliverables. "Blocking" means it must be resolved or consciously accepted before the pilot.

## Open (not fixed)
| ID | Area | Description | Severity | Blocking the pilot? | Mitigation / plan |
|---|---|---|---|---|---|
| K1 | Verification | `test:integration` and `test:e2e:staging` have **never been run** against a real Supabase project. The e2e suite was written against real routes and labels but never executed (no staging). Expect selector drift on the first run. | High (unknown risk) | **Yes** | Provision staging, run both with `HEADED=1`, fix drift. |
| K2 | Verification | Supabase Auth behaviour (token lifetime, refresh rotation, redirect allow-list, e-mail rate limits, cookies) and the hosted default grants are unverified on the real platform. | High (unknown risk) | **Yes** | `scripts/db-validate.mjs` proves grants on the real project; walk the auth checklist in PILOT_READINESS. |
| K3 | Providers | Meta Lead Ads, WhatsApp (Meta Cloud, Interakt) and Razorpay logic is verified against documentation and mocks only; no sandbox account has been exercised. `biz_opaque_callback_data` as a send-request field is referenced but not shown in Meta's message API page. | Medium | Only for the features enabled in the pilot | Phase E with test accounts; keep the feature off until it passes. |
| K4 | Providers | Interakt has no delivery-status handling (status stays *sent*). | Low | No | Use Meta Cloud for the pilot. |
| K5 | AI / voice | AI proposals and voice transcription are covered by unit/DB tests with scripted models, never against the live model on staging. | Medium | Only if AI is enabled | Run the gated e2e tests with a capped key. |
| K6 | Scale | Counting screens grow linearly with visible rows (each row costs ≈ 25–30 µs in row security): home summary ≈ 1.3 s for an extreme user in a 20,000-lead workspace. | Low (pilot-sized data is far smaller) | No | Summary counters before ≥ 50,000 leads per workspace. |
| K7 | Search | Results are drawn from the first 2,000 candidates per type; a very broad query by someone who can see few rows may miss matches. | Low | No | Narrow the query; documented trade-off. |
| K8 | Security | No script-src Content-Security-Policy (frame/base/form/object restrictions are set). HSTS depends on the host. | Low | No | Nonce-based CSP as a later hardening task. |
| K9 | Ops | Operations cannot alert if the whole database is unreachable (it runs on the database). | Low | No | External uptime monitor on `/api/health` (does not touch the DB) and a DB-level monitor in Supabase. |
| K10 | Ops | Integration encryption key rotation and worker token renewal are tested locally but have not been drilled on staging. | Medium | Drill before go-live | `docs/KEY_ROTATION.md`, `docs/WORKERS.md`. |
| K11 | Platform | Rehearsed on PostgreSQL 18.7; Supabase hosts 15/17. Hosted-layout (extensions schema, API role search path) was rehearsed; engine-version differences were not. | Low | Confirm on staging | `db-validate` checks version ≥ 15. |
| K12 | Naming | `0001_foundation_DRAFT.sql` keeps its historical name. Renaming would make it look like a new migration. | Info | No | Do not rename. |
| K13 | Notifications | In-app only. No e-mail/push/SMS exists and the UI says so. | Info | No | By design for the pilot. |

## Fixed during Tasks 15–17 (for the record)
Payment idempotency race (0021); payments connectable without evidence (0024); search/home-summary slowness (0026); internal functions callable by browsers (0022); missing HTTP security headers; silent worker-token expiry; non-rotatable encryption key; and in Task 17 the lack of any guard against pointing a deployment, script or test at the wrong Supabase project (runtime target guard, script locks, preflight).

## How to add one
Add a row here with an ID, reproduction, severity, and whether it blocks. A fix ships as a new migration or code change plus a test that fails without it.
