// Validates a database after the migrations: PostgreSQL version, extensions, the five catalog security checks (docs/STAGING.md), roles, the migration ledger, and the checksums. Read-only.
//   STAGING_DATABASE_URL=postgresql://… node scripts/db-validate.mjs --confirm-ref <ref> [--json]
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { targetProblem, describeTarget, loadEnvFile } from './lib/target.mjs';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
loadEnvFile(arg('--env-file'));
const url = process.env.STAGING_DATABASE_URL; if (!url) { console.error('Set STAGING_DATABASE_URL.'); process.exit(2); }
const problem = targetProblem(url, { confirmRef: arg('--confirm-ref') }); if (problem) { console.error(`REFUSED: ${problem}`); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: describeTarget(url).local ? false : { rejectUnauthorized: false } }); await c.connect(); const q = async (s, p) => (await c.query(s, p)).rows;
const ANON_API = ['integration_ingest_form', 'integration_receive_webhook', 'payment_gateway_connection', 'payment_gateway_receive', 'worker_health_check'];
const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail: detail ?? '' });
try {
  const ver = Number((await q('show server_version_num'))[0].server_version_num); check('pg', 'PostgreSQL 15 or newer', ver >= 150000, `server_version_num ${ver}`);
  const ext = await q(`select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname in ('pgcrypto','btree_gist')`); check('ext', 'extensions pgcrypto and btree_gist installed', ext.length === 2, ext.map(e => `${e.extname}@${e.nspname}`).join(', ') || 'missing');
  const files = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort(); const ledger = new Map((await q(`select version, sha256 from public.optizen_schema_migrations`).catch(() => [])).map(r => [r.version, r.sha256]));
  const sha = f => createHash('sha256').update(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url))).digest('hex'); const missing = files.filter(f => !ledger.has(f.slice(0, 4))); const changed = files.filter(f => ledger.has(f.slice(0, 4)) && ledger.get(f.slice(0, 4)) !== sha(f));
  check('ledger', `all ${files.length} migrations recorded (scripts/db-apply.mjs ledger; skip if you used supabase db push)`, missing.length === 0, missing.length ? `not recorded: ${missing.map(f => f.slice(0, 4)).join(', ')}` : ''); check('checksums', 'no applied migration was edited', changed.length === 0, changed.join(', '));
  check('1', 'every SECURITY DEFINER function pins search_path', (await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`)).length === 0);
  const noRls = await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`); check('2', 'every table has row level security', noRls.length === 0, noRls.map(r => r.relname).join(', '));
  const anonT = await q(`select table_name from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name <> 'optizen_schema_migrations'`); const authW = await q(`select table_name, privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE') and table_name <> 'optizen_schema_migrations'`);
  check('3', 'anon has no table privileges; browsers have no table write privileges', anonT.length === 0 && authW.length === 0, [...anonT.map(r => `anon:${r.table_name}`), ...authW.map(r => `${r.table_name}:${r.privilege_type}`)].slice(0, 8).join(', '));
  const anonFns = (await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') order by 1`)).map(r => r.proname); check('4', 'the anonymous API is exactly the five secret-gated functions', JSON.stringify(anonFns) === JSON.stringify([...ANON_API].sort()), anonFns.join(', '));
  const inv = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and p.prokind='f' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')`); check('4b', 'no invoker function is callable anonymously', inv.length === 0, inv.map(r => r.proname).join(', '));
  const roles = await q(`select (select count(*) from pg_roles where rolname='optizen_worker')::int w, (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> 'optizen_schema_migrations')::int t, (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and coalesce(c.reloptions::text,'') not like '%security_invoker=true%')::int v`);
  check('5', 'worker role exists; 71 tables; every view runs with the caller\'s permissions', roles[0].w === 1 && roles[0].t === 71 && roles[0].v === 0, `worker_role=${roles[0].w} tables=${roles[0].t} views_without_invoker=${roles[0].v}`);
  const sec = (await q(`select has_column_privilege('authenticated','public.integration_credentials','ciphertext','SELECT') a, has_column_privilege('authenticated','public.integration_connections','secret_hash','SELECT') b, has_column_privilege('authenticated','public.invitations','token_hash','SELECT') c, has_column_privilege('authenticated','public.contacts','phone','SELECT') d, has_column_privilege('authenticated','public.contacts','email','SELECT') e`))[0];
  check('6', 'secret columns and contact phone/email are not readable by browsers', !sec.a && !sec.b && !sec.c && !sec.d && !sec.e, JSON.stringify(sec));
  const trg = await q(`select (select count(*) from pg_trigger where tgname='integration_payments_evidence')::int t`); check('7', 'payments activation evidence trigger present (0024)', trg[0].t === 1);
} finally { await c.end(); }
const failed = results.filter(r => !r.pass);
if (process.argv.includes('--json')) console.log(JSON.stringify({ pass: failed.length === 0, results }, null, 1)); else { for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(9)} ${r.name}${!r.pass && r.detail ? `  [${r.detail}]` : ''}`); console.log(failed.length ? `\n${failed.length} check(s) FAILED: do not continue.` : '\nAll checks passed.'); }
process.exit(failed.length ? 1 : 0);
