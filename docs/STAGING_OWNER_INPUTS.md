# What the owner must provide (nothing below exists yet, so no staging resource has been created)

Claude Code and the repository can prepare, rehearse and verify everything locally. They cannot, and must not, create remote resources, spend money, use your accounts or apply anything to a hosted database without your explicit approval. This is the complete list of what is needed, in the order it unblocks work.

## A. Approvals (a yes/no from you)
| # | Approval | Unblocks |
|---|---|---|
| A1 | Create a **new** Supabase project named `optizen-staging` (never the production-labelled one) | Phase B |
| A2 | Apply migrations 0001–0026 to that project with `scripts/db-apply.mjs` (plan first, then `--apply`) | Phase B |
| A3 | Create a staging Vercel project and a staging Fly app (`optizen-workers-staging`) | Phase C |
| A4 | Run `test:integration` and `test:e2e:staging` against staging (they create and delete `it-*@example.test` users and workspaces) | Phase B/D |
| A5 | Use sandbox/test accounts for Meta, WhatsApp, Razorpay and AI (below), with **no real customer numbers** | Phase E |

## B. Accounts and credentials (give them to the deployment, not to chat)
| Item | Where it goes | Notes |
|---|---|---|
| Supabase staging: project ref, API URL, anon key, service-role key, JWT secret, DB connection string, DB password | password manager; `STAGING_DATABASE_URL` only on the operator machine | the service-role key and JWT secret never go on the web app |
| Staging web origin (Vercel URL or domain) | `NEXT_PUBLIC_SITE_URL`, Supabase Auth Site URL + redirect `https://<origin>/auth/callback` | https only |
| SMTP provider for sign-in e-mails (Resend, Postmark, SES…) | Supabase Auth → SMTP | the built-in mailer is heavily rate limited |
| New encryption key (`openssl rand -base64 32`), gateway secret (≥ 32 chars), monitor token (≥ 16 chars) | web app + workers env | generated fresh for staging; never reuse production |
| Worker token | `node worker/mint-worker-token.mjs 365` with the staging JWT secret | |
| Uptime monitor (any: Better Stack, UptimeRobot…) | monitor `GET /api/health` and `GET /api/health/workers` with the monitor token | |
| Meta **test** app (roles-only access is enough, no App Review needed for your own Page) | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | production use needs Business Verification + App Review |
| WhatsApp Cloud API **test number** from the Meta developer console, a permanent token, one approved template | Builder → Connections → WhatsApp | recipients limited to numbers you add to the test list |
| Razorpay **test mode** account, webhook secret | Builder → Connections → Payments | test cards only; no live key |
| Anthropic API key with a **hard spend cap** (and a speech-to-text credential if voice is to be tested) | staging web env only | |

## C. Time and people
An hour with whoever administers Supabase/Vercel/Fly; a second person for the invitation and permission checks; 2–3 hours of human walkthrough on staging (Phase F checklist).

## D. Already prepared in the repository
environment checks (`npm run preflight -- web|workers|tests --env-file <file>`), `scripts/db-apply.mjs`, `scripts/db-validate.mjs`, the runtime target guard (`OPTIZEN_ENV` + `STAGING_SUPABASE_REF`), the staging test suites and their remote-target locks, the runbooks. Rehearsed locally against a hosted-layout database by `npm run test:provisioning`.
