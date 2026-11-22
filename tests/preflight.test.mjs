// Staging preflight and the runtime target guard: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { preflight, crossCheck, worst } from '../scripts/lib/preflight.mjs';
import { checkTarget, projectRef } from '../src/lib/env-guard.ts';

const jwt = c => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.sig`;
const REF = 'stgstgstgstg12', PROD = 'prodprodprod12', KEY = randomBytes(32).toString('base64');
const web = { OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: REF, SUPABASE_PRODUCTION_REF: PROD, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: REF }), NEXT_PUBLIC_SITE_URL: 'https://stg.example.com', INTEGRATION_ENCRYPTION_KEY: KEY, INTEGRATION_GATEWAY_SECRET: 'g'.repeat(40), OPS_HEALTH_TOKEN: 'o'.repeat(20) };
const workers = { OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: REF, SUPABASE_URL: web.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_ANON_KEY: web.NEXT_PUBLIC_SUPABASE_ANON_KEY, WORKER_JWT: jwt({ role: 'optizen_worker', exp: Math.floor(Date.now() / 1000) + 200 * 86400 }), INTEGRATION_ENCRYPTION_KEY: KEY };
const fails = items => items.filter(i => i.level === 'FAIL').map(i => i.name);

test('runtime target guard: staging can never run against production, production never against staging, and a missing ref is refused', () => {
  const s = { OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: REF, SUPABASE_PRODUCTION_REF: PROD };
  assert.equal(checkTarget({ ...s, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }), null); assert.match(checkTarget({ ...s, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }), /not STAGING_SUPABASE_REF/);
  assert.match(checkTarget({ OPTIZEN_ENV: 'staging', NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }), /requires STAGING_SUPABASE_REF/); assert.match(checkTarget({ OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: PROD, SUPABASE_PRODUCTION_REF: PROD, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }), /PRODUCTION/);
  assert.match(checkTarget({ OPTIZEN_ENV: 'production', STAGING_SUPABASE_REF: REF, SUPABASE_URL: `https://${REF}.supabase.co` }), /STAGING project/); assert.equal(checkTarget({ OPTIZEN_ENV: 'production', STAGING_SUPABASE_REF: REF, SUPABASE_URL: `https://${PROD}.supabase.co` }), null);
  assert.match(checkTarget({ OPTIZEN_ENV: 'prod' }), /must be production/); assert.match(checkTarget({ OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: REF, SUPABASE_URL: 'http://localhost:54321' }), /not a hosted project/); assert.equal(checkTarget({}), null, 'an undeclared local setup is untouched'); assert.equal(checkTarget({ OPTIZEN_ENV: 'development', SUPABASE_URL: 'http://localhost:54321' }), null); assert.equal(projectRef('https://evil.example.com/x'), null);
});

test('worker processes refuse to start against the wrong project (real process)', () => {
  const r = spawnSync(process.execPath, ['worker/maintenance-worker.mjs', '--once'], { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH, OPTIZEN_ENV: 'staging', STAGING_SUPABASE_REF: REF, SUPABASE_PRODUCTION_REF: PROD, SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'x' } });
  assert.equal(r.status, 1); assert.match(r.stderr, /Startup refused: .*not STAGING_SUPABASE_REF/); assert.ok(!r.stdout.includes('worker started'));
});

test('preflight: a correct configuration passes; every mistake is named without echoing a value', () => {
  assert.deepEqual(fails(preflight('web', web)), []); assert.deepEqual(fails(preflight('workers', workers)), []); assert.equal(worst(preflight('web', web)), 1, 'AI and Meta not configured are warnings, not failures'); assert.deepEqual(fails(crossCheck(web, workers)), []);
  const cases = [['web', { ...web, SUPABASE_SERVICE_ROLE_KEY: 'x' }, /SUPABASE_SERVICE_ROLE_KEY is NOT set/], ['web', { ...web, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'service_role' }) }, /NEXT_PUBLIC_SUPABASE_ANON_KEY is valid/], ['web', { ...web, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: PROD }) }, /NEXT_PUBLIC_SUPABASE_ANON_KEY is valid/],
    ['web', { ...web, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }, /target guard/], ['web', { ...web, INTEGRATION_ENCRYPTION_KEY: 'short' }, /INTEGRATION_ENCRYPTION_KEY is valid/], ['web', { ...web, NEXT_PUBLIC_SITE_URL: 'http://stg.example.com/' }, /NEXT_PUBLIC_SITE_URL is valid/], ['web', { ...web, OPTIZEN_ENV: 'production' }, /OPTIZEN_ENV is valid/], ['web', { ...web, META_APP_ID: '1' }, /Meta settings are complete/],
    ['workers', { ...workers, WORKER_JWT: jwt({ role: 'service_role', exp: 9999999999 }) }, /optizen_worker role/], ['workers', { ...workers, WORKER_JWT: jwt({ role: 'optizen_worker', exp: Math.floor(Date.now() / 1000) + 5 * 86400 }) }, /at least 30 days/], ['workers', { ...workers, WORKER_JWT: undefined }, /WORKER_JWT or WORKER_JWT_FILE/], ['workers', { ...workers, SUPABASE_JWT_SECRET: 's' }, /SUPABASE_JWT_SECRET is NOT set/]];
  for (const [t, env, re] of cases) { const items = preflight(t, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined))); assert.ok(fails(items).some(n => re.test(n)), `${t}: expected a failure matching ${re}, got ${JSON.stringify(fails(items))}`); }
  assert.deepEqual(fails(crossCheck(web, { ...workers, INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('base64') })), ['web and workers use the same INTEGRATION_ENCRYPTION_KEY']);
  const dump = JSON.stringify(cases.flatMap(([t, env]) => preflight(t, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined))))); for (const secret of [KEY, 'g'.repeat(40), 'o'.repeat(20), web.NEXT_PUBLIC_SUPABASE_ANON_KEY]) assert.ok(!dump.includes(secret), 'no secret value appears in any message');
  const tests = { SUPABASE_TEST_URL: `https://${REF}.supabase.co`, SUPABASE_TEST_ANON_KEY: jwt({ role: 'anon', ref: REF }), SUPABASE_TEST_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: REF }), SUPABASE_TEST_ALLOW_REMOTE: '1', SUPABASE_TEST_STAGING_REF: REF, STAGING_SUPABASE_REF: REF, APP_URL: 'https://stg.example.com' }; assert.deepEqual(fails(preflight('tests', tests)), []);
  assert.ok(fails(preflight('tests', { ...tests, SUPABASE_TEST_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: PROD }) })).length > 0, 'a service key from another project is caught'); assert.ok(fails(preflight('tests', { ...tests, SUPABASE_TEST_ALLOW_REMOTE: undefined })).length > 0);
});

test('preflight CLI: reads only the named file, exits 1 on failure, never prints values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-')); const f = join(dir, 'web.env'); writeFileSync(f, Object.entries({ ...web, INTEGRATION_ENCRYPTION_KEY: 'bad-key-value-xyz' }).map(([k, v]) => `${k}=${v}`).join('\n'));
  const r = spawnSync(process.execPath, ['scripts/preflight.mjs', 'web', '--env-file', f], { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH } }); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL  INTEGRATION_ENCRYPTION_KEY is valid/); assert.ok(!r.stdout.includes('bad-key-value-xyz')); assert.match(r.stdout, /PASS  migration chain 0001–0026 is contiguous \(26 files\)/);
  writeFileSync(f, Object.entries(web).map(([k, v]) => `${k}=${v}`).join('\n')); const ok = spawnSync(process.execPath, ['scripts/preflight.mjs', 'web', '--env-file', f], { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH } }); assert.equal(ok.status, 0, ok.stdout);
});
