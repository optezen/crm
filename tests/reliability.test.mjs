// Task 15 reliability tests: worker loop, heartbeats, least privilege, maintenance, consent, at-most-once delivery, reminders. Real PostgreSQL (PGlite) with migrations 0001-0020. No provider is ever contacted. No provider or network is contacted.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [EMP, EMP2, MGR, ADM] = ['c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
const VEH = { key: 'vehicles', label: 'Vehicles', fields: [{ key: 'registration', label: 'Registration', kind: 'text' }, { key: 'status', label: 'Status', kind: 'choice', options: ['Available', 'Sold'] }, { key: 'price', label: 'Price', kind: 'currency', currency: 'INR' }, { key: 'owner_phone', label: 'Owner Phone', kind: 'phone' }, { key: 'weight', label: 'Weight', kind: 'number' }] };
const OPS = { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false }, inventory: { enabled: true, track_batches: true, track_expiry: true }, billing: { enabled: true, currency: 'INR', taxes: [{ key: 'gst18', name: 'GST 18%', rate: '18' }] } };
const CFG = { ...BASE, modules: [...CORE, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [VEH], operations: OPS };

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const q = async (sql, p) => (await db.query(sql, p)).rows;
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const isJson = v => v !== null && typeof v === 'object';
const ARR = { p_branches: 'uuid', p_ids: 'uuid', p_types: 'text', p_offsets: 'integer' };
const mkRpc = user => async (fn, args = {}) => {
  const keys = Object.keys(args);
  const ph = (k, i) => (Array.isArray(args[k]) && ARR[k] ? `coalesce((select array_agg(x::${ARR[k]}) from jsonb_array_elements_text($${i + 1}::jsonb) x), '{}')` : `$${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`);
  try { const r = await as(user, `select public.${fn}(${keys.map((k, i) => `${k} => ${ph(k, i)}`).join(', ')}) r`, keys.map(k => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]))); return { data: r.rows[0].r, error: null }; }
  catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
};
const call = (u, fn, args) => mkRpc(u)(fn, args);
const ok = async p => { const r = await p; assert.ifError(r.error); return r.data; };
const bad = async (p, code, re) => { const r = await p; assert.ok(r.error, 'expected an error'); if (code) assert.equal(r.error.code, code, r.error.message); if (re) assert.match(r.error.message, re); return r.error; };
async function worker(sql, params = []) { await db.exec('set role service_role'); try { return await db.query(sql, params); } finally { await db.exec('reset role'); } }
const tick = () => worker('select public.automation_tick(500, 50) r').then(r => r.rows[0].r);
const drain = async () => { for (let i = 0; i < 6; i++) { const r = await tick(); if (!r.dispatched && !Object.keys(r.runs).length) return; } };
const days = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let seq = 70;
async function fresh(cfg = CFG) {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test') on conflict do nothing`);
  const org = await ok(call(owner, 'create_workspace', { p_name: `Perm ${seq}`, p_description: null, p_preset: null, p_definition: BASE })).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await ok(call(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  if (cfg) { await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: cfg })); await ok(call(owner, 'publish_workspace_config', { p_org: org })); }
  return { org, owner };
}
const lead = (u, org, name, phone, o = {}) => ok(call(u, 'crm_create_lead', { p_org: org, p_full_name: name, p_phone: phone, p_email: o.email ?? null, p_source: o.source ?? 'website', p_summary: null, p_stage: o.stage ?? null, p_assigned_to: o.assignee ?? null }));
async function boot() {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
}
before(boot);
import { runLoop, newHealth, isHealthy, backoffMs, errorClass } from '../src/lib/workers/loop.ts';
const wq = async (sql, params = []) => { await db.exec('set role service_role'); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
const asWorker = async (sql, params = []) => { await db.exec('set role optizen_worker'); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
const KOLKATA = { ...BASE, operations: { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false } } };
const WAURL = async (org, owner) => { const ex = await q(`select id from public.integration_connections where organization_id=$1 and provider='whatsapp'`, [org]); if (ex.length) return ex[0].id; const c = await q(`insert into public.integration_connections (organization_id, provider, name, status, config, created_by) values ($1,'whatsapp','WA','connected','{"provider":"meta_cloud","template_name":"lead_welcome","template_language":"en"}'::jsonb,$2) returning id`, [org, owner]); return c[0].id; };
const sys = () => db.exec(`select set_config('request.jwt.claim.sub', '', false)`);

// ================= worker loop (pure) =================
const mkLoop = (o = {}) => { const calls = { sleeps: [], beats: [], logs: [] }; let t = 0, stop = false; const d = { name: 'automation', instance: 'i1', version: 'v', pollMs: 1000, heartbeatMs: 30_000, health: newHealth(0), now: () => t, sleep: async ms => { calls.sleeps.push(ms); t += ms; }, shouldStop: () => stop, log: l => calls.logs.push(l),
  heartbeat: async (stats, error) => { calls.beats.push({ stats, error }); }, tick: async () => ({ busy: false }), ...o }; return { d, calls, stopAfter: n => { const orig = d.tick; let i = 0; d.tick = async () => { const r = await orig(); if (++i >= n) stop = true; return r; }; } }; };
test('worker loop: failures back off, the heartbeat carries only an error class, a missed heartbeat never stops work, shutdown is clean', async () => {
  let n = 0; const m = mkLoop({ tick: async () => { n++; if (n <= 3) throw Object.assign(new Error('boom: customer 9876543210 failed'), { code: 'PGRST301' }); return { busy: false, stats: { runs: 2 } }; } }); m.stopAfter(5);
  await runLoop(m.d); assert.deepEqual(m.calls.sleeps.slice(0, 3), [2000, 4000, 8000], 'exponential backoff'); assert.ok(m.calls.beats.some(b => b.error === 'PGRST301'), 'error class reported');
  assert.ok(!JSON.stringify(m.calls.beats).includes('9876543210') && !JSON.stringify(m.calls.beats).includes('boom'), 'no message text or data in heartbeats'); assert.equal(m.d.health.consecutiveFailures, 0, 'recovers'); assert.ok(m.d.health.ticks >= 2);
  assert.ok(m.calls.logs.some(l => l.level === 'info' && l.message === 'worker stopped'));
  const brk = mkLoop({ heartbeat: async () => { throw new Error('db down'); }, tick: async () => ({ busy: false }) }); brk.stopAfter(3); await runLoop(brk.d); assert.equal(brk.d.health.ticks, 3, 'work continued although heartbeats failed');
  const once = mkLoop({ once: true, tick: async () => { throw new Error('x'); } }); await assert.rejects(runLoop(once.d)); const ok1 = mkLoop({ once: true, tick: async () => ({ busy: true }) }); assert.equal((await runLoop(ok1.d)).ticks, 1);
  assert.deepEqual([backoffMs(1), backoffMs(6), backoffMs(30)], [2000, 60000, 60000]); assert.equal(errorClass(new TypeError('x')), 'TypeError'); assert.equal(errorClass({ code: 'a b/c' }), 'abc');
  const busy = mkLoop({ tick: async () => ({ busy: true }) }); busy.stopAfter(3); await runLoop(busy.d); assert.deepEqual(busy.calls.sleeps, [], 'a busy worker does not sleep');
  const h = newHealth(0); assert.ok(isHealthy(h, 10_000, 5000)); assert.ok(!isHealthy(h, 100_000, 5000), 'no tick for too long'); h.lastOkAt = 99_000; assert.ok(isHealthy(h, 100_000, 5000)); h.consecutiveFailures = 9; assert.ok(!isHealthy(h, 100_000, 5000));
});

// ================= heartbeats, diagnostics, least privilege =================
test('heartbeats and diagnostics: workers report, administrators see health and their own queues only, nobody else sees anything', async () => {
  const { org, owner } = await fresh(BASE); const B = await fresh(BASE);
  await wq(`select public.worker_heartbeat('automation', 'm1-1', 'v1', '{"ticks":5}', null)`); await wq(`select public.worker_heartbeat('integrations', 'm2-1', 'v1', '{}', 'PGRST301')`);
  const s = await ok(call(owner, 'worker_status', { p_org: org })); assert.deepEqual(s.workers.map(w => [w.worker, w.healthy]), [['automation', true], ['integrations', true]]); assert.equal(s.workers[1].last_error, 'PGRST301');
  await q(`update public.worker_heartbeats set last_seen = now() - interval '5 minutes' where worker='automation'`); assert.equal((await ok(call(owner, 'worker_status', { p_org: org }))).workers[0].healthy, false, 'stale heartbeat = unhealthy');
  for (const u of [EMP, MGR]) await bad(call(u, 'worker_status', { p_org: org }), '42501'); await bad(call(B.owner, 'worker_status', { p_org: org }), '42501'); await assert.rejects(as(null, `select public.worker_status('${org}')`), e => e.code === '42501');
  await assert.rejects(as(owner, `select public.worker_heartbeat('automation','x','v','{}',null)`), e => e.code === '42501', 'clients cannot post heartbeats'); await assert.rejects(as(owner, 'select * from public.worker_heartbeats'), e => e.code === '42501');
  // queue counts are scoped to the caller's organization
  const w = await ok(call(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'W', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] } })); await ok(call(owner, 'automation_publish', { p_org: org, p_workflow: w, p_enable: true }));
  const l = await lead(owner, org, 'Queued Lead', '+919890000001'); await lead(owner, org, 'Second', '+919890000002'); await wq('select public.automation_tick(50, 0)');
  assert.ok(Object.values((await ok(call(owner, 'worker_status', { p_org: org }))).queues.automation_runs).reduce((a, b) => a + b, 0) >= 1); assert.deepEqual((await ok(call(B.owner, 'worker_status', { p_org: B.org }))).queues.automation_runs, {}); assert.ok(l);
  await wq(`select public.worker_heartbeat('maintenance', repeat('x', 200), repeat('v', 100), '{}', repeat('e', 500))`); const mrow = (await q(`select instance, version, last_error from public.worker_heartbeats where worker='maintenance'`))[0]; assert.deepEqual([mrow.instance.length, mrow.version.length, mrow.last_error.length], [80, 40, 300], 'inputs are bounded');
});
test('least privilege: the worker role can run the worker API and read encrypted credential blobs, and nothing else', async () => {
  const { org, owner } = await fresh(BASE); await lead(owner, org, 'Secret Lead', '+919890000003');
  assert.ok((await asWorker(`select public.worker_heartbeat('automation','lp','v','{}',null) r`)).length === 1); assert.ok((await asWorker('select public.automation_tick(5, 5) r')).length === 1); assert.ok((await asWorker('select public.maintenance_tick() r')).length === 1);
  for (const sql of ['select * from public.leads', 'select * from public.contacts', 'select * from public.integration_connections', 'select * from public.organization_members', 'select * from public.integration_credentials', 'select * from public.invoices', 'select * from public.audit_events', 'delete from public.leads'])
    await assert.rejects(asWorker(sql), e => e.code === '42501', sql);
  assert.deepEqual(await asWorker('select connection_id, ciphertext from public.integration_credentials'), []);
  for (const fn of ["crm_create_lead('00000000-0000-0000-0000-000000000000','x',null,null,null,null,null,null)", "global_search('00000000-0000-0000-0000-000000000000','abc',null,5,0)", "invite_create('00000000-0000-0000-0000-000000000000','a@b.co','employee',null,'{}',7)", 'billing_apply_provider_payment(null,null,1,$$INR$$,$$x$$,$$card$$)']) await assert.rejects(asWorker(`select public.${fn}`), e => e.code === '42501', fn);
  await assert.rejects(asWorker('select public.worker_status($1)', [org]).catch(e => { throw e; }), e => e.code === '42501' || e.code === '42883');
});

// ================= maintenance =================
test('maintenance: overdue follow-ups once per task per day for active members who want them; running it twice changes nothing', async () => {
  const { org, owner } = await fresh(BASE); const l = await lead(owner, org, 'Overdue Lead', '+919890000004', { assignee: EMP }); await sys();
  for (const [u, t] of [[EMP, 'Mine late'], [EMP2, 'Muted late'], [MGR, 'Inactive late']]) await q(`insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, created_by) values ($1,$2,$3,$4,current_date - 2,$5)`, [org, l, t, u, owner]);
  await q(`delete from public.notifications`); await ok(call(EMP2, 'notification_prefs_save', { p_org: org, p_task_assigned: true, p_lead_assigned: true, p_task_overdue: false, p_automation: true })); await ok(call(owner, 'set_member_active', { p_org: org, p_user: MGR, p_active: false })); await sys();
  const r1 = (await wq('select public.maintenance_tick() r'))[0].r; assert.equal(r1.overdue_notifications >= 1, true); const mine = async () => (await q(`select user_id, title from public.notifications where category='task_overdue' and organization_id=$1`, [org]));
  assert.deepEqual((await mine()).map(n => [n.user_id, n.title]), [[EMP, 'Overdue: Mine late']], 'muted and inactive members get nothing');
  const r2 = (await wq('select public.maintenance_tick() r'))[0].r; assert.equal((await mine()).length, 1, 'idempotent within the day'); assert.equal(r2.overdue_notifications, 0);
  await q(`update public.tasks set status='done', outcome='ok', completed_at=now() where title='Mine late'`); await q(`delete from public.notifications`); await wq('select public.maintenance_tick()'); assert.deepEqual(await mine(), [], 'completed tasks are not chased');
});

// ================= consent and at-most-once delivery =================
const seedRequest = async (org, owner, { consent = 'opted_in', lead: l } = {}) => {
  const conn = await WAURL(org, owner); const lid = l ?? await lead(owner, org, 'Msg Person', `+9198900${String(Math.floor(Math.random() * 90000) + 10000)}`); await sys(); const contact = (await q('select contact_id c from public.leads where id=$1', [lid]))[0].c;
  if (consent) await q(`insert into public.messaging_consent (organization_id, contact_id, channel, status, source, note) values ($1,$2,'whatsapp',$3,'import','fixture')`, [org, contact, consent]);
  const req = (await q(`insert into public.integration_requests (organization_id, channel, kind, dedupe_key, payload) values ($1,'whatsapp','automation',$2,$3) returning id`, [org, `t:${Math.random()}`, JSON.stringify({ lead_id: lid, phone: '+919890000009', message: 'hello' })]))[0].id; return { conn, contact, req, lid };
};
test('consent: nothing is claimed without recorded opt-in; opt-out stops queued messages; every decision is logged without message text or numbers', async () => {
  await q('delete from public.integration_requests'); const { org, owner } = await fresh(BASE); const a = await seedRequest(org, owner, { consent: null });
  assert.deepEqual(await wq('select * from public.integration_claim_requests(5)'), [], 'no consent: not claimed'); const st = (await q('select status, last_error from public.integration_requests where id=$1', [a.req]))[0]; assert.equal(st.status, 'failed'); assert.match(st.last_error, /no WhatsApp consent/i);
  const b = await seedRequest(org, owner, { consent: 'opted_out' }); assert.deepEqual(await wq('select * from public.integration_claim_requests(5)'), []); assert.match((await q('select last_error from public.integration_requests where id=$1', [b.req]))[0].last_error, /opted out/);
  assert.deepEqual((await q(`select event from public.outbound_message_log where organization_id=$1 order by created_at, event`, [org])).map(r => r.event).sort(), ['blocked_no_consent', 'blocked_opt_out']);
  const c = await seedRequest(org, owner); const queued = await seedRequest(org, owner, { consent: 'opted_in' }); await ok(call(owner, 'consent_set', { p_org: org, p_contact: queued.contact, p_status: 'opted_out', p_source: 'staff', p_note: 'asked to stop' }));
  assert.equal((await q('select status from public.integration_requests where id=$1', [queued.req]))[0].status, 'cancelled', 'opt-out cancels what was queued'); const claimed = await wq('select * from public.integration_claim_requests(5)'); assert.deepEqual(claimed.map(r => r.id), [c.req]);
  assert.ok(!JSON.stringify(await q('select * from public.outbound_message_log')).match(/9890000009|hello/), 'the audit log holds no message text or phone numbers');
  // who may record consent, and how
  const l2 = await lead(owner, org, 'Visible To Emp', '+919890000010', { assignee: EMP }), l3 = await lead(owner, org, 'Hidden From Emp', '+919890000011', { assignee: EMP2 }); const cid = async l => (await q('select contact_id c from public.leads where id=$1', [l]))[0].c; await sys();
  const set = (u, contact, o = {}) => call(u, 'consent_set', { p_org: org, p_contact: contact, p_status: 'opted_in', p_source: 'staff', p_note: 'Ticked the box on our form', ...o });
  await ok(set(EMP, await cid(l2))); await bad(set(EMP, await cid(l3)), 'P0002'); await bad(set(EMP, await cid(l2), { p_note: 'x' }), '22023'); await bad(set(EMP, await cid(l2), { p_source: 'import' }), '42501'); await bad(set(owner, id('00')), 'P0002'); await bad(set(owner, await cid(l2), { p_status: 'maybe' }), '22023');
  await ok(call(owner, 'consent_set', { p_org: org, p_contact: await cid(l3), p_status: 'opted_in', p_source: 'staff', p_note: 'owner recorded' })); assert.deepEqual((await rows(EMP, 'select status from public.messaging_consent where contact_id=$1', [await cid(l2)])).map(r => r.status), ['opted_in']); assert.deepEqual(await rows(EMP, 'select 1 from public.messaging_consent where contact_id=$1', [await cid(l3)]), [], 'consent of contacts you cannot see is hidden'); assert.deepEqual(await rows(EMP, 'select 1 from public.messaging_consent_log where contact_id=$1', [await cid(l3)]), []);
  const other = await fresh(BASE); await bad(call(other.owner, 'consent_set', { p_org: other.org, p_contact: await cid(l2), p_status: 'opted_in', p_source: 'staff', p_note: 'abc' }), 'P0002');
});
test('at-most-once delivery: a crash mid-send is never retried automatically, completing twice changes nothing, only an administrator can send again', async () => {
  await q('delete from public.integration_requests'); const { org, owner } = await fresh(BASE); const a = await seedRequest(org, owner);
  let [claim] = await wq('select * from public.integration_claim_requests(5)'); assert.equal(claim.id, a.req); assert.equal(claim.attempts, 1); assert.deepEqual(await wq('select * from public.integration_claim_requests(5)'), [], 'claimed once');
  // the worker dies here: the provider may or may not have accepted the message
  await q(`update public.integration_requests set locked_until = now() - interval '1 minute' where id=$1`, [a.req]); assert.deepEqual(await wq('select * from public.integration_claim_requests(5)'), [], 'an expired lease does NOT make it claimable again');
  const m = (await wq('select public.maintenance_tick() r'))[0].r; assert.equal(m.uncertain_messages, 1); const row = (await q('select status, last_error, attempts from public.integration_requests where id=$1', [a.req]))[0]; assert.equal(row.status, 'failed'); assert.match(row.last_error, /Delivery uncertain/);
  assert.equal((await q(`select count(*)::int n from public.outbound_message_log where request_id=$1 and event='uncertain'`, [a.req]))[0].n, 1); await wq('select public.maintenance_tick()'); assert.equal((await q(`select count(*)::int n from public.outbound_message_log where request_id=$1 and event='uncertain'`, [a.req]))[0].n, 1, 'logged once');
  assert.deepEqual(await wq('select * from public.integration_claim_requests(5)'), [], 'still not re-sent');
  // a person decides: only admins, only failed messages the provider did not accept
  await bad(call(EMP, 'integration_requeue_request', { p_org: org, p_request: a.req }), '42501'); const B = await fresh(BASE); await bad(call(B.owner, 'integration_requeue_request', { p_org: org, p_request: a.req }), '42501');
  await ok(call(owner, 'integration_requeue_request', { p_org: org, p_request: a.req })); [claim] = await wq('select * from public.integration_claim_requests(5)'); assert.equal(claim.id, a.req);
  assert.equal((await wq(`select public.integration_complete_request($1, true, 'wamid.1', null, false) r`, [a.req]))[0].r, 'sent'); assert.equal((await wq(`select public.integration_complete_request($1, true, 'wamid.2', null, false) r`, [a.req]))[0].r, 'sent', 'a second completion is ignored');
  assert.equal((await q('select provider_message_id from public.integration_requests where id=$1', [a.req]))[0].provider_message_id, 'wamid.1'); await bad(call(owner, 'integration_requeue_request', { p_org: org, p_request: a.req }), '22023');
  // retryable provider failures back off and stop after 5 attempts; a transient failure is the only thing retried
  const b = await seedRequest(org, owner); for (let i = 1; i <= 5; i++) { await q(`update public.integration_requests set next_attempt_at = now() - interval '1 second' where id=$1`, [b.req]); const [c] = await wq('select * from public.integration_claim_requests(5)'); assert.equal(c.attempts, i); const r = (await wq(`select public.integration_complete_request($1, false, null, 'timeout', true) r`, [b.req]))[0].r; assert.equal(r, i < 5 ? 'requested' : 'failed'); }
  const log = (await q(`select event from public.outbound_message_log where request_id=$1`, [b.req])).map(r => r.event); assert.equal(log.filter(e => e === 'retry').length, 4); assert.equal(log.at(-1), 'failed');
  const { rows: ev } = await db.query(`select count(*)::int n from public.outbound_message_log l where l.organization_id <> $1 and l.request_id = $2`, [org, a.req]); assert.equal(ev[0].n, 0, 'logs stay in their organization'); assert.deepEqual(await rows(EMP, 'select 1 from public.outbound_message_log'), []); assert.ok((await rows(owner, 'select 1 from public.outbound_message_log')).length >= 4);
  assert.ok((await ok(call(owner, 'outbound_messages_recent', { p_org: org, p_limit: 10 }))).length >= 3); await bad(call(EMP, 'outbound_messages_recent', { p_org: org, p_limit: 10 }), '42501');
});

// ================= appointment reminders =================
const remSetup = async (o = {}) => {
  const { org, owner } = await fresh(KOLKATA); await sys(); const ty = (await q(`insert into public.appointment_types (organization_id, name, duration_minutes, created_by) values ($1,'Consultation',30,$2) returning id`, [org, owner]))[0].id;
  const l = await lead(owner, org, 'Reminder Person', `+9198700${String(Math.floor(Math.random() * 90000) + 10000)}`); await sys(); const contact = (await q('select contact_id c from public.leads where id=$1', [l]))[0].c;
  const save = (u, over = {}) => call(u, 'reminder_settings_save', { p_org: org, p_enabled: true, p_offsets: [1440, 60], p_staff: true, p_customer: true, p_template: 'appt_reminder', p_language: 'en', p_quiet_from: null, p_quiet_to: null, ...over });
  let seq = 0; const appt = async (startsAt, extra = {}) => { await sys(); seq++; return (await q(`insert into public.appointments (organization_id, type_id, staff_id, contact_id, starts_at, ends_at, created_by, notes) values ($1,$2,$3,$4,$5::timestamptz + make_interval(mins => $7),$5::timestamptz + make_interval(mins => $7 + 30),$6,'private clinical note') returning id`, [org, ty, extra.staff ?? EMP, extra.contact === null ? null : contact, startsAt, owner, extra.exact ? 0 : seq * 45]))[0].id; };
  const reminders = id => q('select offset_minutes, audience, status, reason, due_at from public.appointment_reminders where appointment_id=$1 order by starts_at, offset_minutes, audience', [id]);
  const days = n => new Date(Date.now() + n * 864e5).toISOString();
  return { org, owner, ty, contact, save, appt, reminders, days };
};
test('reminder settings: validated, administrators only, and organization-scoped', async () => {
  const { org, owner, save } = await remSetup(); await ok(save(owner)); for (const u of [MGR, EMP]) await bad(save(u), '42501');
  for (const o of [{ p_offsets: [] }, { p_offsets: [1, 60] }, { p_offsets: [60, 60] }, { p_offsets: [10081] }, { p_offsets: [1, 2, 3, 4, 5].map(x => x * 10) }, { p_template: null }, { p_language: 'english' }, { p_quiet_from: '08:00' }]) await bad(save(owner, o), '22023');
  await ok(save(owner, { p_customer: false, p_template: null, p_language: null })); assert.deepEqual(await rows(EMP, 'select 1 from public.reminder_settings'), []); const other = await fresh(BASE); assert.deepEqual(await rows(other.owner, 'select 1 from public.reminder_settings'), []); await bad(call(other.owner, 'reminder_settings_save', { p_org: org, p_enabled: true, p_offsets: [60], p_staff: true, p_customer: false, p_template: null, p_language: null, p_quiet_from: null, p_quiet_to: null }), '42501');
});
test('reminder schedule: created per appointment, rebuilt on reschedule without duplicates, cancelled with the appointment or when turned off', async () => {
  const t = await remSetup(); await ok(t.save(t.owner)); const a = await t.appt(t.days(3));
  assert.deepEqual((await t.reminders(a)).map(r => [r.offset_minutes, r.audience, r.status]), [[60, 'customer', 'pending'], [60, 'staff', 'pending'], [1440, 'customer', 'pending'], [1440, 'staff', 'pending']]);
  assert.equal((await t.reminders(await t.appt(new Date(Date.now() + 30 * 60e3).toISOString(), { exact: true }))).length, 0, 'reminder times already in the past are not created retroactively'); assert.equal((await t.reminders(await t.appt(t.days(3), { contact: null }))).filter(r => r.audience === 'customer').length, 0, 'no contact, no customer reminder');
  const d5 = t.days(5); await sys(); await q(`update public.appointments set starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '30 minutes' where id=$1`, [a, d5]);
  const after = await t.reminders(a); assert.equal(after.filter(r => r.status === 'cancelled').length, 4); assert.equal(after.filter(r => r.status === 'pending').length, 4); assert.match(after.find(r => r.status === 'cancelled').reason, /rescheduled/);
  await q(`update public.appointments set starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '30 minutes' where id=$1`, [a, d5]); assert.equal((await t.reminders(a)).length, 8, 'saving the same time again creates nothing');
  await q(`update public.appointments set status = 'cancelled' where id=$1`, [a]); assert.equal((await t.reminders(a)).filter(r => r.status === 'pending').length, 0); assert.match((await t.reminders(a))[0].reason, /cancelled|rescheduled/);
  const b = await t.appt(t.days(4)); assert.equal((await t.reminders(b)).filter(r => r.status === 'pending').length, 4); await ok(t.save(t.owner, { p_enabled: false })); assert.equal((await t.reminders(b)).filter(r => r.status === 'pending').length, 0, 'turning reminders off cancels what is pending');
  await ok(t.save(t.owner, { p_enabled: true, p_offsets: [30] })); assert.deepEqual((await t.reminders(b)).filter(r => r.status === 'pending').map(r => r.offset_minutes), [30, 30], 'changed offsets rebuild the schedule');
  const other = await fresh(BASE); assert.deepEqual(await rows(other.owner, 'select 1 from public.appointment_reminders'), []); assert.deepEqual(await rows(EMP, 'select 1 from public.appointment_reminders'), [], 'employees do not see the schedule');
});
test('staff reminders: one in-app notification in the organization\'s time zone, never repeated, not resent after rescheduling back', async () => {
  const t = await remSetup(); await ok(t.save(t.owner, { p_customer: false, p_template: null, p_language: null, p_offsets: [60] })); const start = '2030-06-15T03:30:00Z'; const a = await t.appt(start);
  await sys(); await q(`update public.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id=$1`, [a]); const r = (await wq('select public.reminders_process(50) r'))[0].r; assert.deepEqual([r.staff_sent, r.customer_queued], [1, 0]);
  const n = await rows(EMP, `select title, body, link from public.notifications where category='reminder'`); assert.equal(n.length, 1); assert.equal(n[0].body, '15 Jun 2030 at 09:45 (Asia/Kolkata)', 'UTC 04:15 (03:30 + the 45-minute fixture offset) is 09:45 in Kolkata'); assert.equal(n[0].link, `/work/appointments/${a}`); assert.ok(!JSON.stringify(n).includes('clinical'), 'no private notes in notifications');
  await wq('select public.reminders_process(50)'); assert.equal((await rows(EMP, `select 1 from public.notifications where category='reminder'`)).length, 1, 'processing again sends nothing');
  await q(`update public.appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id=$1`, [a]); await q(`update public.appointments set starts_at = starts_at - interval '1 day', ends_at = ends_at - interval '1 day' where id=$1`, [a]); await q(`update public.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id=$1 and status='pending'`, [a]); await wq('select public.reminders_process(50)');
  assert.equal((await rows(EMP, `select 1 from public.notifications where category='reminder'`)).length, 1, 'a reminder already sent for this time is not sent again'); assert.deepEqual(await rows(EMP2, `select 1 from public.notifications where category='reminder'`), [], 'only the assigned staff member');
  await ok(call(EMP, 'notification_prefs_save', { p_org: t.org, p_task_assigned: true, p_lead_assigned: true, p_task_overdue: true, p_automation: true }));
  // an appointment that is cancelled or already started when the reminder falls due is not announced
  const b = await t.appt(t.days(2)); await sys(); await q(`update public.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id=$1`, [b]); await q(`update public.appointments set status='no_show' where id=$1`, [b]); await wq('select public.reminders_process(50)'); assert.equal((await rows(EMP, `select 1 from public.notifications where category='reminder'`)).length, 1);
});
test('customer reminders: only with a connected provider, an approved template, a phone number and recorded consent; minimal content; skipped with the reason otherwise; deduplicated', async () => {
  await q('delete from public.integration_requests'); const t = await remSetup(); await ok(t.save(t.owner, { p_staff: false, p_offsets: [60] }));
  const due = async (a) => { await sys(); await q(`update public.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id=$1 and status='pending'`, [a]); return (await wq('select public.reminders_process(50) r'))[0].r; };
  const reason = async a => (await t.reminders(a))[0];
  let a = await t.appt(t.days(2)); await due(a); assert.deepEqual([(await reason(a)).status, (await reason(a)).reason], ['skipped', 'No WhatsApp provider is connected.']);
  const conn = await WAURL(t.org, t.owner); a = await t.appt(t.days(2)); await due(a); assert.match((await reason(a)).reason, /No WhatsApp consent/);
  await sys(); await q(`insert into public.messaging_consent (organization_id, contact_id, channel, status, source) values ($1,$2,'whatsapp','opted_out','import')`, [t.org, t.contact]); a = await t.appt(t.days(2)); await due(a); assert.match((await reason(a)).reason, /opted out/);
  await q(`update public.messaging_consent set status='opted_in' where organization_id=$1`, [t.org]); a = await t.appt('2030-06-15T03:30:00Z', { exact: true }); const r = await due(a); assert.deepEqual([r.customer_queued, (await reason(a)).status], [1, 'queued']);
  const [req] = await q(`select kind, dedupe_key, payload, status from public.integration_requests where dedupe_key like 'reminder:%'`); assert.equal(req.kind, 'reminder'); assert.equal(req.status, 'requested');
  assert.deepEqual(Object.keys(req.payload).sort(), ['contact_id', 'params', 'phone', 'template_language', 'template_name'], 'only what the template needs'); assert.deepEqual(req.payload.params, ['Consultation', '15 Jun 2030', '09:00']); assert.ok(!JSON.stringify(req.payload).match(/clinical|note|staff/), 'no protected appointment details');
  await wq('select public.reminders_process(50)'); assert.equal((await q(`select count(*)::int n from public.integration_requests where dedupe_key like 'reminder:%'`))[0].n, 1, 'no duplicate request');
  const [c] = await wq('select * from public.integration_claim_requests(5)'); assert.equal(c.payload.template_name, 'appt_reminder'); assert.equal(c.connection_id, conn); assert.ok((await q(`select count(*)::int n from public.outbound_message_log where event in ('queued','blocked_no_provider','blocked_no_consent','blocked_opt_out')`))[0].n >= 4);
});
test('quiet hours use the organization\'s time zone: a reminder inside the window is deferred to its end, or skipped when that is after the appointment; outside it is sent', async () => {
  const t = await remSetup(); await ok(t.save(t.owner, { p_customer: false, p_template: null, p_language: null, p_offsets: [60] }));
  const local = async (h) => (await q(`select to_char((now() at time zone 'Asia/Kolkata') + interval '${h} hours', 'HH24:MI') t`))[0].t;
  const run = async (a) => { await sys(); await q(`update public.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id=$1 and status='pending'`, [a]); return (await wq('select public.reminders_process(50) r'))[0].r; };
  await ok(t.save(t.owner, { p_customer: false, p_template: null, p_language: null, p_offsets: [60], p_quiet_from: await local(-1), p_quiet_to: await local(1) })); let a = await t.appt(t.days(2)); let r = await run(a);
  assert.equal(r.staff_sent, 0); const [dr] = await t.reminders(a); assert.equal(dr.status, 'pending'); const mins = (new Date(dr.due_at) - Date.now()) / 60e3; assert.ok(mins > 55 && mins < 65, `deferred to the end of the window (~60 min): ${mins}`);
  a = await t.appt(new Date(Date.now() + 100 * 3600e3).toISOString()); await sys(); await q(`update public.appointments set starts_at = now() + interval '30 minutes', ends_at = now() + interval '60 minutes' where id=$1`, [a]); await q(`insert into public.appointment_reminders (organization_id, appointment_id, starts_at, offset_minutes, audience, due_at) select organization_id, id, starts_at, 99, 'staff', now() - interval '1 minute' from public.appointments where id=$1`, [a]);
  r = await run(a); assert.equal(r.skipped >= 1, true); assert.match((await q(`select reason from public.appointment_reminders where appointment_id=$1 and offset_minutes=99`, [a]))[0].reason, /quiet hours and after/);
  await ok(t.save(t.owner, { p_customer: false, p_template: null, p_language: null, p_offsets: [60], p_quiet_from: await local(3), p_quiet_to: await local(5) })); a = await t.appt(t.days(2)); r = await run(a); assert.equal(r.staff_sent, 1, 'outside the window it is sent');
  // a window that wraps midnight in Kolkata time
  await ok(t.save(t.owner, { p_customer: false, p_template: null, p_language: null, p_offsets: [60], p_quiet_from: await local(-0.5), p_quiet_to: await local(-1) })); a = await t.appt(t.days(2)); r = await run(a); assert.equal(r.staff_sent, 0, 'a wrap-around window containing now defers'); assert.equal((await t.reminders(a))[0].status, 'pending');
});
