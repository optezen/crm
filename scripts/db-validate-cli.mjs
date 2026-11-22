// The same checks as scripts/db-validate.mjs, but run through the Supabase CLI against a project ref (read-only; no connection string or password needed).
//   node scripts/db-validate-cli.mjs <project-ref> [--json]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const EXPECTED = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).length;
const ref = process.argv[2]; if (!/^[a-z0-9]{10,30}$/.test(ref ?? '')) { console.error('Usage: node scripts/db-validate-cli.mjs <project-ref>'); process.exit(2); }
const ANON_API = ['integration_ingest_form', 'integration_receive_webhook', 'payment_gateway_connection', 'payment_gateway_receive', 'worker_health_check'];
const notExt = "not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')";
const sql = `select jsonb_build_object(
 'pg', current_setting('server_version_num')::int,
 'ext', (select coalesce(jsonb_agg(e.extname || '@' || n.nspname), '[]') from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname in ('pgcrypto','btree_gist')),
 'definer_no_path', (select coalesce(jsonb_agg(p.proname), '[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')),
 'no_rls', (select coalesce(jsonb_agg(c.relname), '[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity),
 'anon_tables', (select coalesce(jsonb_agg(table_name), '[]') from information_schema.role_table_grants where grantee='anon' and table_schema='public'),
 'auth_writes', (select coalesce(jsonb_agg(table_name || ':' || privilege_type), '[]') from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),
 'anon_definer', (select coalesce(jsonb_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and ${notExt}),
 'anon_invoker', (select coalesce(jsonb_agg(p.proname), '[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not p.prosecdef and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and ${notExt}),
 'worker_role', (select count(*) from pg_roles where rolname='optizen_worker'),
 'tables', (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'),
 'views_not_invoker', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and coalesce(c.reloptions::text,'') not like '%security_invoker=true%'),
 'secret_cols', (select jsonb_build_object('cipher', has_column_privilege('authenticated','public.integration_credentials','ciphertext','SELECT'), 'secret_hash', has_column_privilege('authenticated','public.integration_connections','secret_hash','SELECT'), 'token_hash', has_column_privilege('authenticated','public.invitations','token_hash','SELECT'), 'phone', has_column_privilege('authenticated','public.contacts','phone','SELECT'), 'email', has_column_privilege('authenticated','public.contacts','email','SELECT'))),
 'trigger', (select count(*) from pg_trigger where tgname='integration_payments_evidence'),
 'migrations', (select count(*) from supabase_migrations.schema_migrations)
) as r`;
const p = spawnSync('npx', ['supabase', 'db', 'query', `--remote=${ref}`, '--read-only', sql], { encoding: 'utf8', maxBuffer: 1 << 24 }); if (p.status !== 0) { console.error(p.stderr || p.stdout); process.exit(2); }
const json = p.stdout.slice(p.stdout.indexOf('{')); const r = JSON.parse(json).rows[0].r; const results = [];
const check = (id, name, pass, detail = '') => results.push({ id, name, pass: !!pass, detail });
check('pg', 'PostgreSQL 15 or newer', r.pg >= 150000, `server_version_num ${r.pg}`); check('ext', 'extensions pgcrypto and btree_gist installed', r.ext.length === 2, r.ext.join(', '));
check('ledger', `${EXPECTED} migrations recorded`, r.migrations === EXPECTED, `${r.migrations} recorded`);
check('1', 'every SECURITY DEFINER function pins search_path', r.definer_no_path.length === 0, r.definer_no_path.join(', '));
check('2', 'every table has row level security', r.no_rls.length === 0, r.no_rls.join(', '));
check('3', 'anon has no table privileges; browsers have no table write privileges', r.anon_tables.length === 0 && r.auth_writes.length === 0, [...r.anon_tables, ...r.auth_writes].slice(0, 8).join(', '));
check('4', 'the anonymous API is exactly the five secret-gated functions', JSON.stringify(r.anon_definer) === JSON.stringify([...ANON_API].sort()), r.anon_definer.join(', '));
check('4b', 'no invoker function is callable anonymously', r.anon_invoker.length === 0, r.anon_invoker.join(', '));
check('5', "worker role exists; 71 tables; every view runs with the caller's permissions", r.worker_role === 1 && r.tables === 71 && r.views_not_invoker === 0, `worker_role=${r.worker_role} tables=${r.tables} views_without_invoker=${r.views_not_invoker}`);
check('6', 'secret columns and contact phone/email are not readable by browsers', !Object.values(r.secret_cols).some(Boolean), JSON.stringify(r.secret_cols)); check('7', 'payments activation evidence trigger present (0024)', r.trigger === 1);
const failed = results.filter(x => !x.pass); if (process.argv.includes('--json')) console.log(JSON.stringify({ pass: !failed.length, results }, null, 1)); else { for (const x of results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.id.padEnd(7)} ${x.name}${x.detail ? `  [${x.detail}]` : ''}`); console.log(failed.length ? `\n${failed.length} FAILED: do not continue.` : '\nAll checks passed.'); }
process.exit(failed.length ? 1 : 0);
