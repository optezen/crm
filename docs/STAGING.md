# Staging environment (a separate Supabase project)

Goal: a real, disposable, production-like environment where the pilot is rehearsed and every live test runs. **Never run these steps, or any test in this repository, against the existing production-labelled Supabase project.** The live test suites enforce this: a remote project is accepted only when `SUPABASE_TEST_STAGING_REF` names it and it is not `SUPABASE_PRODUCTION_REF`.

## 1. Create the project
1. Supabase dashboard → New project. Name it `optizen-staging`. Choose the **same region and plan tier** you will use in production (so latency, connection limits and PITR behave alike). Generate and store a new database password.
2. Note: the project ref (the `abcdefghijklmnop` in `https://abcdefghijklmnop.supabase.co`), the API URL, the anon key, the service-role key and the JWT secret (Project settings → API). These five are staging-only secrets: put them in your password manager, never in the repository.
3. Authentication → URL configuration: Site URL = the staging web URL; add `https://<staging-web>/auth/callback` to Redirect URLs. Authentication → Providers: Email on. Use a real SMTP provider for staging (the built-in mailer is heavily rate limited) or test accounts you can read.
4. Database → Extensions: `pgcrypto` and `btree_gist` (migration 0010 creates `btree_gist` itself; confirm both exist afterwards).

## 2. Apply the migrations (in order, once)
Run on **staging only**, with the SQL editor or `supabase link --project-ref <staging-ref>` then `supabase db push`. The files are `supabase/migrations/0001` … `0026`, contiguous and in order. Do not edit an applied migration; fixes ship as new numbers.

Validate immediately (all should be empty / as stated):
```sql
-- 1. every definer function pins search_path                       -> 0 rows
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%');
-- 2. every table has row level security                             -> 0 rows
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
-- 3. browsers have no table write privileges, anon has no tables    -> 0 rows each
select table_name from information_schema.role_table_grants where grantee='anon' and table_schema='public';
select table_name, privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
-- 4. the anonymous API is exactly the secret-gated entry points     -> the 5 names below
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 1;
--   integration_ingest_form, integration_receive_webhook, payment_gateway_connection, payment_gateway_receive, worker_health_check
-- 5. migration objects exist
select (select count(*) from pg_roles where rolname='optizen_worker') as worker_role, (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables; -- 1 and 71
```
The same catalog checks run in CI against a local engine (`npm run test:security`); the SQL above is the staging-side proof.

**Supabase-specific check that cannot be rehearsed locally:** Supabase grants `EXECUTE` on new functions and `ALL` on new tables to `anon` and `authenticated` by default. The migrations revoke explicitly, and query 3 above proves it on the real project. If it returns rows, stop and report.

## 3. Register secrets and the worker role
```sql
select public.integration_set_gateway_secret('<the same value as INTEGRATION_GATEWAY_SECRET>');   -- once; run with the service role / SQL editor
```
Mint the worker token on an operator machine: `SUPABASE_JWT_SECRET='<staging jwt secret>' node worker/mint-worker-token.mjs 365`.

## 4. Deploy staging services (separate from production)
| Service | Staging name | Notes |
|---|---|---|
| Web app | a separate Vercel project/environment `optizen-staging` | env below |
| Workers | `fly apps create optizen-workers-staging`; copy `fly.worker.toml`, change `app =` | secrets below; never share the production Fly app |

Web app env (staging values only): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `INTEGRATION_ENCRYPTION_KEY` (a **new** key; never reuse production's), `INTEGRATION_GATEWAY_SECRET`, `OPS_HEALTH_TOKEN`; Meta/WhatsApp/Razorpay **test** credentials only when you are ready to test those providers; `ANTHROPIC_API_KEY` only with a capped test key. The service-role key is never set on the web app.
Worker secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WORKER_JWT`, `INTEGRATION_ENCRYPTION_KEY` (same as the web app).

Smoke check: `GET /api/health` → 200. `GET /api/health/workers` with `Authorization: Bearer <OPS_HEALTH_TOKEN>` → 200 once all three workers report (503 names the missing one). Builder → Operations shows the same.

## 5. Run the live suites against staging (only after you authorize it)
```bash
cp .env.test.example .env.test.local          # git-ignored
# fill: SUPABASE_TEST_URL, _ANON_KEY, _SERVICE_ROLE_KEY (staging), SUPABASE_TEST_ALLOW_REMOTE=1,
#       SUPABASE_TEST_STAGING_REF=<staging ref>, SUPABASE_PRODUCTION_REF=<production ref>, APP_URL=<staging web URL>
npm run test:integration       # database + route tests against the real project
npm run test:e2e:staging       # authenticated browser/HTTP flows (first run with HEADED=1; see the header of the file)
```
The suites create users `it-*@example.test` and workspaces and delete them afterwards; if a run is interrupted, delete leftovers by that prefix.

## 6. What a staging pass must prove (go/no-go evidence)
- Migration chain applied without error; the five catalog queries above pass.
- `integration`, `e2e:staging` suites green; `npm run test:security`, `test:concurrency`, `test:workers`, `test:perf` green locally on the same commit.
- Sign up/in, create workspace, invite and accept, lead + follow-up, custom module, automation published and executed by the **real worker**, appointment, stock movement, invoice + PDF, reports, AI (controlled key) all exercised by a human once.
- Worker kill/restart drill and token renewal drill performed (docs/WORKERS.md), key rotation rehearsed (docs/KEY_ROTATION.md), backup restore drill performed (docs/RELEASE.md).

## 7. Teardown / reset
Staging data is disposable: delete the project, or `truncate` through a reset script run by you. Never copy production data into staging without masking contact details.
