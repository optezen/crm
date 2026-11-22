# Deployment record

One entry per deployment to a hosted environment. Fill it in as you go; keep it in the repository (no secrets: names, refs and results only).

## Current status
**Nothing has been deployed.** No staging resource exists; no migration has been applied to any hosted database; no code was pushed. The production-labelled Supabase project has not been touched. (Recorded at commit of the Task 17 deliverables.)

## Template
```
Environment:        staging | production
Date / operator:
Git commit:         <sha>   Branch/tag:
Approval:           who approved, where (link/ticket)
Supabase project:   ref <ref>   region   plan   Postgres version
Backup point before migration:  PITR timestamp / backup id
Preflight:          node scripts/preflight.mjs web … / workers … / tests …      result: PASS/WARN/FAIL (attach output)
Migrations:         node scripts/db-apply.mjs … (plan output attached)  → applied 0001–00xx, duration
Validation:         node scripts/db-validate.mjs …                                 result
Web deployment:     Vercel project / deployment id / URL
Workers:            Fly app / release id / machines (automation, integrations, maintenance)
Secrets set:        names only (no values), date, who
Health:             /api/health 200 ✔  /api/health/workers 200 ✔  Operations shows 3 workers ✔
Suites run:         test:integration ✔/✘  test:e2e:staging ✔/✘  (counts)  other:
Drills:             worker kill/restart ✔  token renewal ✔  key rotation ✔  backup restore ✔
Provider tests:     Meta ✔/✘/skipped  WhatsApp ✔/✘/skipped  Razorpay ✔/✘/skipped  AI ✔/✘/skipped
Defects found:      ids → docs/KNOWN_DEFECTS.md
Rollback taken?     no | yes (what, why)
Sign-off:           name / date
```

## Log
| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| — | — | `<this commit>` | not deployed | Local rehearsal only: `test:provisioning` applied 0001–0026 to a local hosted-layout database, validated it, and rehearsed refusal paths. |
