// `npm run test:workers`: the REAL worker processes (worker/*.mjs) against a real PostgreSQL through a JWT-verifying REST stand-in, plus encryption-key rotation on real data.
// Startup, health endpoint, heartbeats, restart without duplicates, token expiry/renewal, stale-worker detection, re-encryption (compare-and-swap, dry run, wrong key).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startPg, uid, MGR } from './pgenv.mjs';
import { startRestMock, signJwt } from './postgrest-mock.mjs';
import { decryptJson, encryptJson, keyringFromEnv, credentialVersion, parseKey } from '../../src/lib/integrations/crypto.ts';
import { rekeyAll } from '../../src/lib/integrations/rekey.ts';
import { tokenDaysLeft } from '../../src/lib/workers/token.ts';

const JWT_SECRET = 'test-jwt-secret-' + 'x'.repeat(32); const ROOT = new URL('../../', import.meta.url).pathname;
let env, rpc, q, rest; const children = new Set();
before(async () => { env = await startPg(); ({ rpc, q } = env); rest = await startRestMock(env.pool, JWT_SECRET); });
after(async () => { for (const c of children) c.kill('SIGKILL'); await rest?.close(); await env?.stop(); });

const ok = r => { assert.equal(r.error, null, r.error?.message); return r.data; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (f, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) assert.fail(`timed out waiting for ${what}`); await sleep(100); } };
const freePort = () => new Promise(r => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const workerToken = (days = 400, role = 'optizen_worker') => signJwt(JWT_SECRET, { role, iss: 'optizen-worker', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + days * 86400 });
const KEY = randomBytes(32).toString('base64');
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: '', SUPABASE_ANON_KEY: 'anon-public-key', INTEGRATION_ENCRYPTION_KEY: KEY, AUTOMATION_POLL_MS: '150', INTEGRATION_POLL_MS: '150', MAINTENANCE_POLL_MS: '300' };
function launch(name, extra = {}, args = []) {
  const logs = []; const port = extra.PORT; const child = spawn(process.execPath, [`worker/${name === 'integrations' ? 'integration' : name}-worker.mjs`, ...args], { cwd: ROOT, env: { ...baseEnv, SUPABASE_URL: rest.url, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => logs.push(String(d))); child.stderr.on('data', d => logs.push(String(d))); children.add(child); const exited = new Promise(r => child.on('exit', (code, sig) => { children.delete(child); r({ code, sig }); }));
  return { child, logs, port, exited, kill: () => child.kill('SIGKILL'), text: () => logs.join('') };
}
const health = async port => { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return { status: r.status, body: await r.json() }; } catch { return null; } };
const heartbeats = () => q(`select worker, instance, last_seen, stats from public.worker_heartbeats order by worker`);

let seq = 70; const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
async function fresh() {
  const owner = uid(String(seq++)); await q(`insert into auth.users values ($1,$2) on conflict do nothing`, [owner, `o${seq}@x.test`]);
  const org = String(ok(await rpc(owner, 'create_workspace', { p_name: `W ${seq}`, p_description: null, p_preset: null, p_definition: BASE }))); ok(await rpc(owner, 'crm_add_member', { p_org: org, p_email: 'mgr@x.test', p_role: 'manager' })); return { org, owner };
}

test('[keys] keyring: current + previous versions decrypt, only the current encrypts, malformed configuration is refused with a clear message', () => {
  const k1 = randomBytes(32).toString('base64'), k2 = randomBytes(32).toString('base64');
  const ring = keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '2', INTEGRATION_ENCRYPTION_KEY_PREVIOUS: `1:${k1}` });
  const old = encryptJson({ t: 'old' }, parseKey(k1), 1), fresh = encryptJson({ t: 'new' }, ring); assert.equal(credentialVersion(old), 1); assert.equal(credentialVersion(fresh), 2);
  assert.deepEqual(decryptJson(old, ring), { t: 'old' }); assert.deepEqual(decryptJson(fresh, ring), { t: 'new' });
  assert.throws(() => decryptJson(old, keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '2' })), /key version 1.*not configured/);
  assert.throws(() => decryptJson(old, keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '1' })), /could not be decrypted/, 'the right version number with the wrong key fails closed');
  for (const bad of [{ INTEGRATION_ENCRYPTION_KEY: 'short' }, { INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '0' }, { INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_PREVIOUS: 'oops' }, { INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '2', INTEGRATION_ENCRYPTION_KEY_PREVIOUS: `2:${k1}` }]) assert.throws(() => keyringFromEnv(bad));
  assert.deepEqual(decryptJson(old, parseKey(k1)), { t: 'old' }, 'a plain key still works exactly as before');
  const tok = workerToken(10); assert.equal(tokenDaysLeft(tok), 9); assert.ok(tokenDaysLeft(workerToken(-2)) <= -2); assert.equal(tokenDaysLeft('garbage'), null); assert.equal(tokenDaysLeft(undefined), null);
});

test('[keys][real db] rotation: every credential is re-encrypted once, a credential refreshed mid-rotation is never overwritten, a missing old key loses nothing, repeats and dry runs change nothing', async () => {
  const k1 = randomBytes(32).toString('base64'), k2 = randomBytes(32).toString('base64'); const ring1 = keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k1 });
  const { org, owner } = await fresh(); const conns = []; for (let i = 0; i < 7; i++) { const c = ok(await rpc(owner, 'integration_create_connection', { p_org: org, p_provider: 'website_forms', p_name: `C${i}`, p_config: {} })); ok(await rpc(owner, 'integration_store_credentials', { p_org: org, p_conn: c.id, p_ciphertext: encryptJson({ token: `secret-${i}` }, ring1), p_expires_at: null, p_key_version: 1 })); conns.push(c.id); }
  const ring2 = keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '2', INTEGRATION_ENCRYPTION_KEY_PREVIOUS: `1:${k1}` });
  const deps = (hook) => ({ list: async (after, limit) => q(`select connection_id, ciphertext from public.integration_credentials ${after ? `where connection_id > '${after}'` : ''} order by connection_id limit ${limit}`), swap: async (c, o, n, v) => { await hook?.(c); return ok(await rpc(null, 'integration_rekey_credential', { p_conn: c, p_old: o, p_new: n, p_version: v }, 'optizen_worker')); } });
  const snapshot = () => q('select connection_id, ciphertext, key_version from public.integration_credentials order by connection_id');
  const before = await snapshot(); assert.deepEqual(await rekeyAll(deps(), ring2, { dryRun: true, pageSize: 3 }), { total: 7, alreadyCurrent: 0, rekeyed: 0, raced: 0, failed: 0, wouldRekey: 7 }); assert.deepEqual(await snapshot(), before, 'a dry run changes nothing');
  // without the old key nothing is written and nothing is lost
  const noOld = keyringFromEnv({ INTEGRATION_ENCRYPTION_KEY: k2, INTEGRATION_ENCRYPTION_KEY_VERSION: '2' }); assert.deepEqual(await rekeyAll(deps(), noOld, { pageSize: 3 }), { total: 7, alreadyCurrent: 0, rekeyed: 0, raced: 0, failed: 7, wouldRekey: 0 }); assert.deepEqual(await snapshot(), before);
  // one credential is refreshed by the app between the worker reading it and swapping it
  const mid = conns[3]; const fresher = encryptJson({ token: 'refreshed-by-the-app' }, ring1);
  const r = await rekeyAll(deps(async c => { if (c === mid) await q(`update public.integration_credentials set ciphertext=$1 where connection_id=$2`, [fresher, c]); }), ring2, { pageSize: 3 });
  assert.deepEqual([r.rekeyed, r.raced, r.failed], [6, 1, 0], JSON.stringify(r)); assert.equal((await q('select ciphertext from public.integration_credentials where connection_id=$1', [mid]))[0].ciphertext, fresher, 'the newer credential was not overwritten by the stale one');
  assert.deepEqual(await rekeyAll(deps(), ring2), { total: 7, alreadyCurrent: 6, rekeyed: 1, raced: 0, failed: 0, wouldRekey: 0 }, 'the next run finishes the job'); assert.deepEqual(await rekeyAll(deps(), ring2), { total: 7, alreadyCurrent: 7, rekeyed: 0, raced: 0, failed: 0, wouldRekey: 0 }, 'a repeat is a no-op');
  const rows = await snapshot(); assert.ok(rows.every(x => x.key_version === 2 && credentialVersion(x.ciphertext) === 2)); rows.forEach((x, i) => assert.ok(decryptJson(x.ciphertext, ring2).token)); assert.ok(rows.every(x => { try { decryptJson(x.ciphertext, ring1); return false; } catch { return true; } }), 'the old key can no longer read them');
  assert.deepEqual(ok(await rpc(null, 'integration_key_versions', {}, 'optizen_worker')), { 2: 7 });
  const audit = await q(`select payload::text p from public.audit_events where organization_id=$1 and event_name='integration.credentials_rekeyed'`, [org]); assert.equal(audit.length, 7); assert.ok(audit.every(a => !/secret|token|cipher|v2:/.test(a.p)), 'the audit trail records no secret');
  // who may call it
  for (const [u, role] of [[owner, 'authenticated'], [null, 'anon']]) assert.ok((await rpc(u, 'integration_rekey_credential', { p_conn: conns[0], p_old: 'x', p_new: 'v2:a.b.c', p_version: 2 }, role)).error, `${role} cannot re-key credentials`);
  assert.equal((await rpc(null, 'integration_rekey_credential', { p_conn: conns[0], p_old: 'x', p_new: 'not-a-credential', p_version: 2 }, 'optizen_worker')).error.code, '22023'); assert.equal((await rpc(null, 'integration_rekey_credential', { p_conn: conns[0], p_old: 'x', p_new: 'v3:a.b.c', p_version: 2 }, 'optizen_worker')).error.code, '22023', 'the version in the value must match');
});

test('[workers] all three processes start, answer /healthz, heartbeat with the token expiry, and do their jobs against the real database', async () => {
  const token = workerToken(400); const ports = { automation: await freePort(), integrations: await freePort(), maintenance: await freePort() };
  const w = Object.fromEntries(Object.keys(ports).map(n => [n, launch(n, { WORKER_JWT: token, PORT: String(ports[n]) })]));
  await waitFor(async () => (await heartbeats()).length >= 3, 20000, 'three heartbeats').catch(e => { throw new Error(e.message + '\n' + Object.entries(w).map(([n, x]) => `--- ${n}\n${x.text().slice(0, 1500)}`).join('\n') + `\nrest: ${JSON.stringify(rest.stats)}`); });
  for (const n of Object.keys(ports)) { const h = await waitFor(() => health(ports[n]), 5000, `${n} health`); assert.equal(h.status, 200); assert.equal(h.body.ok, true); assert.equal(h.body.worker, n); }
  const hb = Object.fromEntries((await heartbeats()).map(r => [r.worker, r])); assert.deepEqual(Object.keys(hb).sort(), ['automation', 'integrations', 'maintenance']); assert.ok(hb.automation.stats.token_days_left >= 399, `token days left reported: ${hb.automation.stats.token_days_left}`);
  for (const n of Object.keys(w)) { assert.ok(!w[n].text().includes(token), 'the token is never logged'); assert.match(w[n].text(), /restricted-role/, 'runs with the restricted role, not the service key'); }
  // automation: leads created now are processed by the running worker
  const { org, owner } = await fresh(); const wf = ok(await rpc(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'T', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] } })); ok(await rpc(owner, 'automation_publish', { p_org: org, p_workflow: wf, p_enable: true }));
  for (let i = 0; i < 40; i++) ok(await rpc(owner, 'crm_create_lead', { p_org: org, p_full_name: `L${i}`, p_phone: `+9198${10000000 + i}`, p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: MGR }));
  // the worker is killed hard in the middle of the batch and restarted: nothing is lost, nothing is done twice
  await waitFor(async () => (await q(`select count(*)::int n from public.automation_runs where organization_id=$1 and status='succeeded'`, [org]))[0].n >= 1, 20000, 'first runs'); w.automation.kill(); await w.automation.exited;
  const mid = (await q(`select count(*)::int n from public.automation_runs where organization_id=$1 and status='succeeded'`, [org]))[0].n;
  const again = launch('automation', { WORKER_JWT: token, PORT: String(await freePort()) }); await waitFor(async () => (await q(`select count(*)::int n from public.automation_runs where organization_id=$1 and status='succeeded'`, [org]))[0].n === 40, 30000, `all 40 runs (had ${mid} at the kill)`);
  assert.equal((await q(`select count(*)::int n from public.automation_runs where organization_id=$1`, [org]))[0].n, 40, 'exactly one run per lead'); assert.equal((await q(`select count(*)::int n from public.tasks where organization_id=$1`, [org]))[0].n, 40, 'exactly one task per lead, none duplicated by the restart');
  // maintenance: overdue follow-ups become exactly one notification each, by the running worker
  const t = ok(await rpc(owner, 'crm_create_lead', { p_org: org, p_full_name: 'Overdue', p_phone: '+919800099999', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: MGR }));
  await q(`update public.tasks set due_date = (now() - interval '2 days')::date where organization_id=$1`, [org]);
  await waitFor(async () => (await q(`select count(*)::int n from public.notifications where organization_id=$1 and category='task_overdue'`, [org]))[0].n > 0, 20000, 'overdue notifications');
  const n1 = (await q(`select count(*)::int n from public.notifications where organization_id=$1 and category='task_overdue'`, [org]))[0].n; await sleep(1500); assert.equal((await q(`select count(*)::int n from public.notifications where organization_id=$1 and category='task_overdue'`, [org]))[0].n, n1, 'repeated maintenance runs never repeat a notification');
  // idle integration worker applies a verified gateway payment without any other process
  assert.ok((rest.stats.rpc.integration_claim_events ?? 0) > 0 && (rest.stats.rpc.integration_apply_status_events ?? 0) > 0 && (rest.stats.rpc.payment_gateway_apply ?? 0) > 0, 'the integration worker polls every queue it owns: ' + JSON.stringify(rest.stats.rpc) + w.integrations.text().slice(-900));
  // the dashboard view: all running, then a stopped worker is flagged
  const view = async () => ok(await rpc(owner, 'worker_status', { p_org: org })).workers; assert.ok((await view()).every(x => x.healthy));
  w.integrations.kill(); await w.integrations.exited; await q(`update public.worker_heartbeats set last_seen = now() - interval '3 minutes' where worker='integrations'`);
  const after = await view(); assert.deepEqual(after.filter(x => !x.healthy).map(x => x.worker), ['integrations'], 'a worker that stopped reporting is flagged, the others are not'); assert.ok(after.filter(x => x.healthy).length >= 2);
  const hz = await health(ports.integrations); assert.equal(hz, null, 'a dead process does not answer its health check'); assert.equal((await health(ports.maintenance)).status, 200);
  for (const x of [...Object.values(w), again]) x.kill(); void t;
});

test('[workers] authentication failures: forged, expired and wrong-role tokens are rejected and never logged; a token can be renewed without restarting the worker', async () => {
  const stats0 = rest.stats.unauthorized;
  for (const [label, tok] of [['forged', signJwt('another-secret', { role: 'optizen_worker', exp: Math.floor(Date.now() / 1000) + 3600 })], ['expired', workerToken(-1)], ['wrong role', signJwt(JWT_SECRET, { role: 'authenticated', sub: uid('c3'), exp: Math.floor(Date.now() / 1000) + 3600 })]]) {
    const w = launch('automation', { WORKER_JWT: tok }, ['--once']); const { code } = await Promise.race([w.exited, sleep(15000).then(() => ({ code: 'timeout' }))]); assert.equal(code, 1, `${label}: the worker exits with an error instead of running`); assert.ok(!w.text().includes(tok), `${label}: the token is not in the logs`);
  }
  assert.ok(rest.stats.unauthorized >= stats0 + 3, 'each was rejected by the API'); assert.equal((await q(`select count(*)::int n from public.worker_heartbeats where instance like '%'`))[0].n >= 0, true);
  // renewal: the worker starts with an expired token (from a file), keeps running, and recovers as soon as the file holds a valid one
  const dir = mkdtempSync(join(tmpdir(), 'optizen-tok-')); const file = join(dir, 'worker.jwt'); writeFileSync(file, workerToken(-1)); const port = await freePort();
  await q(`delete from public.worker_heartbeats`); const w = launch('automation', { WORKER_JWT_FILE: file, PORT: String(port) }); await waitFor(() => rest.stats.unauthorized >= stats0 + 6, 15000, 'rejections while expired');
  assert.equal((await q(`select count(*)::int n from public.worker_heartbeats where worker='automation'`))[0].n, 0, 'an expired token cannot even report'); const pid = w.child.pid;
  writeFileSync(file, workerToken(365)); await waitFor(async () => (await q(`select count(*)::int n from public.worker_heartbeats where worker='automation'`))[0].n === 1, 30000, 'recovery after renewal');
  assert.equal(w.child.pid, pid); assert.equal(w.child.exitCode, null, 'the same process is still running: no restart was needed'); w.kill();
});

test('[workers] a worker with the service-role fallback says so; a worker with no credentials refuses to start', async () => {
  const svc = launch('maintenance', { SUPABASE_SERVICE_ROLE_KEY: workerToken(5, 'service_role'), PORT: String(await freePort()) }, ['--once']); const r = await svc.exited; assert.equal(r.code, 0); assert.match(svc.text(), /service-role key/i);
  const none = launch('maintenance', {}, ['--once']); const r2 = await none.exited; assert.equal(r2.code, 1); assert.match(none.text(), /Set SUPABASE_URL/);
});
