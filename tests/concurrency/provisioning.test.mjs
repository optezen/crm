// `npm run test:provisioning`: the staging provisioning scripts (scripts/db-apply.mjs, scripts/db-validate.mjs, scripts/lib/target.mjs) exercised against a LOCAL server laid out like hosted Supabase.
// A dry rehearsal of exactly what the owner will run on the staging project: plan, apply, validate, repeat, tamper, wrong target. Nothing remote is ever contacted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { startPg } from './pgenv.mjs';
const COUNT = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).length;
import { targetProblem, describeTarget } from '../../scripts/lib/target.mjs';

let env, url; process.env.PG_LAYOUT = 'supabase';
before(async () => { env = await startPg({ migrations: false }); url = `postgresql://postgres:pw@localhost:${env.port}/t`; });
after(async () => { await env?.stop(); });
const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: new URL('../../', import.meta.url).pathname, env: { PATH: process.env.PATH, HOME: process.env.HOME, STAGING_DATABASE_URL: url, ...extra }, encoding: 'utf8' });

test('[provision] target safety: a remote database must be named, must match, and must not be production; a local rehearsal database is allowed', () => {
  const U = 'postgresql://postgres:secret@db.abcdefghij1234.supabase.co:5432/postgres', POOL = 'postgresql://postgres.abcdefghij1234:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
  assert.deepEqual([describeTarget(U).ref, describeTarget(POOL).ref, describeTarget(url).local], ['abcdefghij1234', 'abcdefghij1234', true]);
  assert.match(targetProblem(U, { env: {} }), /--confirm-ref/); assert.match(targetProblem(U, { confirmRef: 'zzzzzzzzzzzzzz', env: {} }), /different project/); assert.match(targetProblem(U, { confirmRef: 'abcdefghij1234', env: { SUPABASE_PRODUCTION_REF: 'abcdefghij1234' } }), /PRODUCTION/);
  assert.match(targetProblem(U, { confirmRef: 'abcdefghij1234', env: { STAGING_SUPABASE_REF: 'other1234567890' } }), /not STAGING_SUPABASE_REF/); assert.equal(targetProblem(U, { confirmRef: 'abcdefghij1234', env: { SUPABASE_PRODUCTION_REF: 'prodref123456789' } }), null); assert.equal(targetProblem(POOL, { confirmRef: 'abcdefghij1234', env: {} }), null);
  assert.match(targetProblem('postgresql://u:p@evil.example.com/db', { confirmRef: 'x', env: {} }), /not a Supabase project host/); assert.match(targetProblem('not a url'), /not valid/); assert.equal(targetProblem(url), null);
});

test('[provision] a remote target without the right confirmation is refused before any connection is made', () => {
  for (const [args, env, re] of [[[], {}, /--confirm-ref/], [['--confirm-ref', 'wrongwrongwrong1'], {}, /different project/], [['--confirm-ref', 'abcdefghij1234'], { SUPABASE_PRODUCTION_REF: 'abcdefghij1234' }, /PRODUCTION/]])
    for (const script of ['scripts/db-apply.mjs', 'scripts/db-validate.mjs']) { const r = run(script, args, { STAGING_DATABASE_URL: 'postgresql://postgres:x@db.abcdefghij1234.supabase.co:5432/postgres', ...env }); assert.equal(r.status, 2, `${script}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, re); assert.ok(!/postgresql:\/\//.test(r.stderr + r.stdout), 'the connection string is never printed'); }
});

test('[provision] plan changes nothing; apply runs every migration in order; validation passes; a repeat is a no-op; the schema looks right under the hosted layout', async () => {
  let r = run('scripts/db-apply.mjs'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`${COUNT} migrations in the repository, 0 already applied, ${COUNT} to apply \\(PLAN ONLY`)); assert.equal((await env.q(`select count(*)::int n from information_schema.tables where table_name='organizations'`))[0].n, 0, 'the plan created nothing');
  r = run('scripts/db-apply.mjs', ['--apply']); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal((r.stdout.match(/ applied /g) ?? []).length, COUNT); assert.match(r.stdout, /applied 0027_service_role_grants\.sql/);
  r = run('scripts/db-validate.mjs'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /All checks passed/); for (const id of ['pg ', 'ext ', 'ledger', 'checksums', '1 ', '2 ', '3 ', '4 ', '4b', '5 ', '6 ', '7 ']) assert.match(r.stdout, new RegExp(`PASS  ${id}`));
  assert.deepEqual((await env.q(`select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname in ('pgcrypto','btree_gist')`)).map(x => x.nspname), ['extensions', 'extensions'], 'extensions live in the extensions schema, as on the hosted platform');
  r = run('scripts/db-apply.mjs', ['--apply']); assert.equal(r.status, 0); assert.match(r.stdout, new RegExp(`${COUNT} already applied, 0 to apply`)); assert.equal((r.stdout.match(/ applied /g) ?? []).length, 0);
  assert.equal((await env.q(`select count(*)::int n from public.optizen_schema_migrations`))[0].n, COUNT);
});

test('[provision] an applied migration can never be silently edited, and validation catches real security regressions', async () => {
  const orig = (await env.q(`select sha256 from public.optizen_schema_migrations where version='0020'`))[0].sha256; await env.q(`update public.optizen_schema_migrations set sha256 = repeat('0', 64) where version = '0020'`); let r = run('scripts/db-apply.mjs', ['--apply']); assert.equal(r.status, 3); assert.match(r.stderr, /0020.*checksum mismatch/); r = run('scripts/db-validate.mjs'); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL  checksums/);
  await env.q(`update public.optizen_schema_migrations set sha256 = $1 where version = '0020'`, [orig]); r = run('scripts/db-validate.mjs'); assert.equal(r.status, 0, 'restoring the checksum makes validation pass again');
  const bad = [[`grant insert on public.leads to authenticated`, /FAIL  3/], [`grant execute on function public.global_search(uuid, text, text[], integer, integer) to anon`, /FAIL  4b/], [`grant select (ciphertext) on public.integration_credentials to authenticated`, /FAIL  6/], [`alter table public.leads disable row level security`, /FAIL  2/]];
  for (const [sql, re] of bad) { await env.q(sql); r = run('scripts/db-validate.mjs'); assert.equal(r.status, 1, sql); assert.match(r.stdout, re, sql); const undo = { 'grant insert on public.leads to authenticated': 'revoke insert on public.leads from authenticated', 'grant execute on function public.global_search(uuid, text, text[], integer, integer) to anon': 'revoke execute on function public.global_search(uuid, text, text[], integer, integer) from anon', 'grant select (ciphertext) on public.integration_credentials to authenticated': 'revoke select (ciphertext) on public.integration_credentials from authenticated', 'alter table public.leads disable row level security': 'alter table public.leads enable row level security' }[sql]; await env.q(undo); }
});

test('[provision] a failing migration rolls back alone and says what to do', async () => {
  const fresh = await startPg({ migrations: false }); try { await fresh.q(`create table public.organizations (id int)`); // conflicts with migration 0004/0002: the very first file that creates it fails
    const r = spawnSync(process.execPath, ['scripts/db-apply.mjs', '--apply'], { cwd: new URL('../../', import.meta.url).pathname, env: { PATH: process.env.PATH, STAGING_DATABASE_URL: `postgresql://postgres:pw@localhost:${fresh.port}/t` }, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /FAILED \d{4}_.*rolled back.*restore the pre-release backup/s); assert.ok(!r.stderr.includes('pw@'), 'no credentials in the output'); const done = (await fresh.q(`select count(*)::int n from public.optizen_schema_migrations`))[0].n; assert.ok(done < COUNT); } finally { await fresh.stop(); }
});
