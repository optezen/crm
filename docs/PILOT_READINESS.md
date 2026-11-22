# Pilot readiness checklist (Task 17)

**Verdict: NO-GO for a pilot today; GO to provision staging and run the gates below.** No check that *can* be run locally failed. The pilot is blocked because the checks that need a real Supabase project, a deployed app, deployed workers and provider sandboxes have not been run, and none of those resources exist (see `docs/STAGING_OWNER_INPUTS.md`).

Legend: **PASS** = executed, evidence given · **NOT RUN** = needs the named resource, listed as a gate · **LIMIT** = known limitation (docs/KNOWN_DEFECTS.md). "Local" means a real PostgreSQL 18.7 server (also under a hosted-Supabase layout), the real worker processes and a production build: not the hosted platform.

## 1. Preflight (Phase A)
| Check | Status | Evidence |
|---|---|---|
| Migration chain 0001–0026 contiguous, in order, no gaps | PASS | `scripts/preflight.mjs`, `db-apply.mjs` refuse a gap; `test:provisioning` |
| Full chain applies from empty; applied files cannot be edited unnoticed | PASS | `test:provisioning`: 26 applied, re-run no-op, checksum tamper refused (exit 3), failing migration rolls back alone |
| Extensions and compatibility (`pgcrypto`, `btree_gist`, no unqualified extension calls, PG ≥ 15) | PASS locally | hosted layout (extensions in `extensions` schema, API roles search `public, extensions`): concurrency 7/7, security 6/6, workers 6/6, perf 6/6, provisioning 5/5 |
| Hosted PostgreSQL 15/17 behaviour | NOT RUN | gate G2 (`db-validate` reports server version) |
| Environment checklist | PASS | `scripts/preflight.mjs web\|workers\|tests`: validates names, formats, JWT roles/refs, forbidden variables, same key on web and workers, no value ever printed (`tests/preflight.test.mjs`) |
| Production-labelled project cannot be targeted by accident | PASS | four independent locks: (1) app/worker startup guard (`OPTIZEN_ENV`, `STAGING_SUPABASE_REF`, `SUPABASE_PRODUCTION_REF`): a real production build and a real worker process refuse to start on the wrong ref; (2) `db-apply`/`db-validate` require `--confirm-ref` = connection ref ≠ production (production ref also read from `.env.local` at runtime, never printed); (3) live test suites require `SUPABASE_TEST_STAGING_REF`; (4) preflight fails on a key belonging to another project |
| Secrets, generated files, history | PASS | full-history scan clean; no `.env*` or build output tracked; `npm audit --omit=dev` 0 |
| Release checklist, rollback, security audit reviewed | PASS | `docs/RELEASE.md`, `docs/SECURITY_AUDIT.md` (no critical/high findings) |

## 2. Authentication
| Check | Status | Evidence |
|---|---|---|
| Route protection, session-less redirect, wrong-org 404 | NOT RUN | `test:e2e:staging` (written, never executed) - gate G5 |
| Magic-link sign-in end to end, redirect allow-list, token lifetime/refresh, cookie flags, e-mail delivery, rate limits | NOT RUN | needs the Supabase Auth config + SMTP - gate G3 (checklist below) |
| Invitations: single use, expiry, revocation, bound to one e-mail, admin-only-by-owner | PASS (DB level) | `test:security` invitations test; UI acceptance in e2e: NOT RUN |
| Security headers (no framing, nosniff, referrer, permissions) | PASS | browser test on a production build |

Auth checklist for staging (G3): Site URL and `…/auth/callback` redirect set; magic link arrives from the SMTP sender and signs in; link reuse fails; JWT expiry and refresh-token rotation enabled; sign-out invalidates the session; unconfirmed/unknown e-mails behave as intended; rate limit hit produces a friendly message.

## 3. Database security
| Check | Status | Evidence |
|---|---|---|
| Five catalog checks (definer search_path, RLS on all tables, no browser table writes / anon tables, anonymous API = 5 secret-gated functions, worker role + table count) plus secret columns and views | PASS locally | `test:security` and `scripts/db-validate.mjs` (negative tests: a stray grant, a disabled RLS, a leaked column each turn it red) |
| Same checks on the **real staging project** (default-grant behaviour) | NOT RUN | gate G2: `node scripts/db-validate.mjs --confirm-ref <ref>` |
| Least privilege: worker role cannot read tables or bypass RLS; service-role key never on the web app | PASS | `tests/reliability.test.mjs`, `preflight` forbids it, `test:workers` |
| Credentials encrypted; key and token rotation | PASS locally | `test:workers` (re-key CAS, dry run, wrong key, renewal without restart); drilled on staging: NOT RUN (G6) |

## 4. Cross-organization isolation
| Check | Status | Evidence |
|---|---|---|
| A stranger reads, writes, or calls against another organization: every org-scoped table/view and 17 sensitive functions | PASS | `test:security` isolation test |
| Contact phone/email, secrets, invoices, payments hidden from unauthorized roles; PII canary scan of every column | PASS | `test:security` privacy and exposure tests |
| Same through real sessions against staging | NOT RUN | `test:integration` (`tenant-isolation`) and `test:e2e:staging` - gate G4/G5 |

## 5. Financial and inventory integrity
| Check | Status | Evidence |
|---|---|---|
| Concurrent payments never over-collect; one idempotency key = one payment; paid event once | PASS | `test:concurrency` (defect found and fixed, 0021) |
| Gateway duplicates and replays under 4 workers = one payment; payment ↔ ledger ↔ audit consistent after a database crash | PASS | `test:concurrency`, `test:perf` (7,000+ acknowledged payments all present after SIGKILL) |
| Concurrent stock deductions: exactly the available units, never negative, ledger = level | PASS | `test:concurrency` |
| Competing appointment bookings: one winner, no overlaps | PASS | `test:concurrency` |
| A payments connection cannot be Active without a verified notification | PASS | DB trigger 0024 + UI + tests |
| Real Razorpay test-mode payment end to end | NOT RUN | gate G8 |

## 6. Worker reliability
| Check | Status | Evidence |
|---|---|---|
| The three real processes start, answer `/healthz`, heartbeat, do their work against a real database under the restricted role | PASS | `test:workers` |
| Hard kill and restart: no lost, no duplicated work (40 runs, 40 tasks) | PASS | `test:workers` |
| Forged / expired / wrong-role tokens rejected and never logged; renewal without restart | PASS | `test:workers` |
| Stale/missing worker detected by the uptime endpoint and Operations | PASS | `test:workers` (monitoring test) |
| Deployed workers on Fly, scheduled jobs, queues, health checks, drills | NOT RUN | gate G6 |

## 7. Critical browser workflows
| Check | Status | Evidence |
|---|---|---|
| Operational screens (Operations, consent, reminders, payments connection): accessibility, phone layout, error states | PASS | 13 browser tests, fixture data |
| Authenticated flows on staging: sign-in state, workspace, invitation, lead + follow-up, automation executed by the real worker, custom module + destructive-change refusal, appointments, inventory, invoice + authorized PDF, reports/dashboards, consent through the UI, role limits | NOT RUN | `test:e2e:staging` (11 tests written, 2 gated on AI/voice keys) - gate G5. First run will probably need selector fixes (K1). |
| AI configuration proposals, voice transcription | NOT RUN | gated tests need a capped key / speech credential - gate G9 |

## 8. Backup and recovery
| Check | Status | Evidence |
|---|---|---|
| Physical backup restored into a new server keeps all data, policies, functions, indexes; restored database works | PASS locally | `test:perf` |
| Hard crash of the database mid-write loses no committed work, breaks no invariant | PASS locally | `test:perf` |
| Supabase backup/PITR enabled; restore drill into a scratch project | NOT RUN | gate G7 (`docs/RELEASE.md` §4) |

## 9. Provider connectivity
| Check | Status | Evidence |
|---|---|---|
| Meta Lead Ads, WhatsApp (Meta Cloud), Razorpay, AI: contract tests against documentation and mocks | PASS | `tests/providers.test.mjs`, `payments.test.mjs`, adapters tests |
| Real sandbox/test accounts | NOT RUN | gate G8; see `docs/STAGING_OWNER_INPUTS.md` §B. Nothing may be sent to a real customer without separate authorization. |

## 10. Known limitations
See `docs/KNOWN_DEFECTS.md` (K1–K13). None is blocking except K1/K2 (unverified on real infrastructure) and K10 (drills).

## Gates to a pilot (in order; each needs the owner approvals in STAGING_OWNER_INPUTS)
| Gate | What | Pass condition |
|---|---|---|
| G1 | Preflight of staging env files | `preflight web/workers/tests` = no FAIL |
| G2 | Staging project created; `db-apply` plan reviewed then applied; `db-validate` | all checks PASS; PG version recorded |
| G3 | Supabase Auth configured; SMTP; sign-in works | auth checklist §2 |
| G4 | `npm run test:integration` against staging | 0 failures |
| G5 | Web + workers deployed; `npm run test:e2e:staging` | 0 failures (after fixing selector drift); automation test proves the real worker ran |
| G6 | Drills on staging: worker kill/restart, token renewal, key rotation, uptime alert fires when a worker is stopped | recorded in the deployment record |
| G7 | Backup/PITR on; restore drill into a scratch project | `db-validate` passes on the restored copy |
| G8 | Provider sandboxes (Meta test app, WhatsApp test number, Razorpay test mode) | feature-by-feature pass; failures turn the feature off for the pilot |
| G9 | AI proposals and voice with a capped key (optional features) | gated e2e pass, or the features are switched off |
| G10 | Human walkthrough by two people (owner and employee) incl. phone | no blocking defect open in KNOWN_DEFECTS |

When G1–G7 and G10 pass, and each enabled provider has passed G8/G9, the recommendation changes to **GO for a controlled pilot** (small named group, one workspace, no real WhatsApp to customers without separate approval, daily check per `docs/OPERATIONS_RUNBOOK.md`).
