// Provider-contract tests (Meta Graph classification, WhatsApp send/status, opt-out, reconciliation). Verified against Meta's public docs on 2026-11-21; HTTP and database only, no provider is contacted.
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
const wq = async (sql, params = []) => { await db.exec('set role service_role'); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
const asWorker = async (sql, params = []) => { await db.exec('set role optizen_worker'); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
const KOLKATA = { ...BASE, operations: { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false } } };
const WAURL = async (org, owner) => { const ex = await q(`select id from public.integration_connections where organization_id=$1 and provider='whatsapp'`, [org]); if (ex.length) return ex[0].id; const c = await q(`insert into public.integration_connections (organization_id, provider, name, status, config, created_by) values ($1,'whatsapp','WA','connected','{"provider":"meta_cloud","template_name":"lead_welcome","template_language":"en"}'::jsonb,$2) returning id`, [org, owner]); return c[0].id; };
const sys = () => db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
const seedRequest = async (org, owner, { consent = 'opted_in', lead: l } = {}) => {
  const conn = await WAURL(org, owner); const lid = l ?? await lead(owner, org, 'Msg Person', `+9198900${String(Math.floor(Math.random() * 90000) + 10000)}`); await sys(); const contact = (await q('select contact_id c from public.leads where id=$1', [lid]))[0].c;
  if (consent) await q(`insert into public.messaging_consent (organization_id, contact_id, channel, status, source, note) values ($1,$2,'whatsapp',$3,'import','fixture')`, [org, contact, consent]);
  const req = (await q(`insert into public.integration_requests (organization_id, channel, kind, dedupe_key, payload) values ($1,'whatsapp','automation',$2,$3) returning id`, [org, `t:${Math.random()}`, JSON.stringify({ lead_id: lid, phone: '+919890000009', message: 'hello' })]))[0].id; return { conn, contact, req, lid };
};
import { classify, GRAPH_VERSION, authUrl, MetaClient } from '../src/lib/integrations/meta.ts';
import { MetaCloudAdapter, parseWhatsAppWebhook } from '../src/lib/integrations/whatsapp.ts';
import { deliverWhatsApp } from '../src/lib/integrations/worker.ts';
import { randomBytes } from 'node:crypto';
import { encryptJson, parseKey } from '../src/lib/integrations/crypto.ts';
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('Graph errors: every documented code and subcode lands in the right class, with an action a person can take', () => {
  const c = (code, sub, status = 400) => classify(status, { error: { code, error_subcode: sub, message: 'm' } });
  for (const [code, sub, kind, re] of [[190, 463, 'auth', /expired/], [190, 467, 'auth', /invalid/], [190, 460, 'auth', /password/], [190, 458, 'auth', /no longer installed/], [190, 492, 'auth', /role/], [190, 459, 'auth', /checkpoint/], [190, 464, 'auth', /checkpoint|unconfirmed/], [190, undefined, 'auth', /Reconnect/],
    [4, undefined, 'rate_limit'], [17, undefined, 'rate_limit'], [32, undefined, 'rate_limit'], [341, undefined, 'rate_limit'], [613, undefined, 'rate_limit'], [80007, undefined, 'rate_limit'], [130429, undefined, 'rate_limit'], [131056, undefined, 'rate_limit'],
    [10, undefined, 'permanent', /permission/], [200, undefined, 'permanent', /permission/], [299, undefined, 'permanent', /permission/], [1, undefined, 'transient'], [2, undefined, 'transient'], [100, undefined, 'permanent'],
    [131050, undefined, 'permanent'], [131026, undefined, 'permanent'], [131047, undefined, 'permanent'], [132001, undefined, 'permanent'], [132000, undefined, 'permanent'], [133010, undefined, 'permanent'], [368, undefined, 'permanent']]) {
    const e = c(code, sub); assert.equal(e.kind, kind, `${code}/${sub}`); if (re) assert.match(e.message, re); assert.equal(e.retryable, kind === 'transient' || kind === 'rate_limit', `${code} retry`);
  }
  assert.equal(classify(502, '<html>').kind, 'transient'); assert.equal(classify(400, undefined).kind, 'permanent');
  assert.ok(!JSON.stringify(c(190, 463)).includes('token'), 'no token value can appear in an error');
});

test('Graph version is one pinned value used by OAuth and every call; a mocked send carries our request id as callback data and nothing else private', async () => {
  assert.match(GRAPH_VERSION, /^v\d+\.\d+$/); assert.ok(authUrl({ appId: '1', redirectUri: 'https://a.test/cb', state: 's' }).includes(`/${GRAPH_VERSION}/dialog/oauth`));
  const calls = []; const f = async (url, init) => { calls.push({ url, init }); return reply(200, { messages: [{ id: 'wamid.X' }] }); };
  const r = await new MetaCloudAdapter(f).send({ to: '919845012345', templateName: 'appt_reminder', language: 'en', bodyParams: ['Mon 10:00'], reference: '11111111-1111-4111-8111-111111111111' }, { access_token: 'tok', phone_number_id: '55' });
  assert.equal(r.messageId, 'wamid.X'); assert.equal(calls[0].url, `https://graph.facebook.com/${GRAPH_VERSION}/55/messages`); const b = JSON.parse(calls[0].init.body);
  assert.deepEqual(b, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919845012345', type: 'template', biz_opaque_callback_data: '11111111-1111-4111-8111-111111111111', template: { name: 'appt_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Mon 10:00' }] }] } });
  assert.ok(!('text' in b), 'only approved templates are ever sent, never free text'); assert.equal(calls[0].init.headers.authorization, 'Bearer tok'); assert.ok(!calls[0].url.includes('tok'), 'the token never goes in the URL');
  await new MetaCloudAdapter(f, 'v99.0').verify({ access_token: 't', phone_number_id: '9' }).catch(() => {}); assert.ok(calls.at(-1).url.includes('/v99.0/9?'));
});

test('delivery worker (mocked HTTP): sends the approved template to the provider, passes the request id, and maps provider failures to retry / opt-out / reconnect', async () => {
  const key = parseKey(randomBytes(32).toString('base64')); const creds = encryptJson({ access_token: 'tok' }, key);
  const run = async (resp, payload = {}) => { const done = []; const bodies = []; const req = { id: '22222222-2222-4222-8222-222222222222', connection_id: 'C', payload: { phone: '+919845012345', message: 'hi', ...payload }, config: { provider: 'meta_cloud', phone_number_id: '55', template_name: 'lead_welcome', template_language: 'en' } };
    const rpc = async (fn, a) => { if (fn === 'integration_claim_requests') return { data: [req], error: null }; if (fn === 'integration_complete_request') done.push(a); return { data: null, error: null }; };
    const fetch = async (u, i) => { bodies.push(JSON.parse(i.body)); return resp; };
    const out = await deliverWhatsApp({ rpc, credentials: async () => creds, fetch, key }); return { out, done, bodies }; };
  let r = await run(reply(200, { messages: [{ id: 'wamid.7' }] })); assert.deepEqual(r.out, { claimed: 1, sent: 1, failed: 0 }); assert.equal(r.bodies[0].biz_opaque_callback_data, '22222222-2222-4222-8222-222222222222'); assert.deepEqual(r.done[0], { p_request: '22222222-2222-4222-8222-222222222222', p_ok: true, p_message_id: 'wamid.7', p_error: null, p_retryable: false });
  r = await run(reply(400, { error: { code: 131050, message: 'opted out' } })); assert.equal(r.done[0].p_ok, false); assert.equal(r.done[0].p_retryable, false, '131050 is never retried');
  r = await run(reply(400, { error: { code: 131056, message: 'pair limit' } })); assert.equal(r.done[0].p_retryable, true);
  r = await run(reply(400, { error: { code: 132001, message: 'no template' } })); assert.equal(r.done[0].p_retryable, false);
  r = await run(reply(200, {}), { phone: '9845012345' }); assert.match(r.done[0].p_error, /country code/); assert.equal(r.bodies.length, 0, 'an unformattable number never reaches the provider');
});

test('status webhook: every documented status is routed by phone number id with a stable duplicate key; unknown shapes are ignored', () => {
  const st = (o) => parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '55' }, statuses: [{ id: 'w1', timestamp: '1', recipient_id: '9198', ...o }] } }] }] });
  for (const s of ['sent', 'delivered', 'read', 'failed']) assert.deepEqual(st({ status: s })[0].payload.status, s);
  assert.equal(st({ status: 'delivered' })[0].dedupe_key, 'w1:delivered'); assert.equal(st({ status: 'delivered' })[0].dedupe_key, st({ status: 'delivered' })[0].dedupe_key); assert.notEqual(st({ status: 'sent' })[0].dedupe_key, st({ status: 'read' })[0].dedupe_key);
  const f = st({ status: 'failed', biz_opaque_callback_data: 'x'.repeat(200), errors: [{ code: 131050, title: 'Recipient stopped', message: 'm', error_data: { details: 'd' } }], pricing: { billable: true } })[0]; assert.equal(f.payload.callback.length, 64); assert.equal(f.payload.error, '131050 Recipient stopped');
  assert.ok(!JSON.stringify(f).includes('9198'), 'the recipient number is never stored in the event');
  assert.deepEqual(st({ id: undefined, status: 'sent' }).length ? [] : [], []); assert.deepEqual(parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'message_template_status_update', value: {} }] }] }), []);
  assert.deepEqual(parseWhatsAppWebhook(null), []);
});

const hookEvent = (org, conn, payload) => q(`insert into public.integration_webhook_events (organization_id, connection_id, provider, kind, dedupe_key, payload, signature_verified) values ($1,$2,'whatsapp','whatsapp_status',$3,$4,true) returning id`, [org, conn, `${payload.message_id}:${payload.status}:${Math.random()}`, JSON.stringify(payload)]).then(r => r[0].id);
const applyStatuses = () => wq('select public.integration_apply_status_events(100) n').then(r => r[0].n);
const reqRow = id => q('select status, provider_message_id, last_error from public.integration_requests where id=$1', [id]).then(r => r[0]);

test('statuses: advance sent -> delivered -> read, never go backwards, duplicates and strangers change nothing, failures are logged without secrets', async () => {
  await q('delete from public.integration_requests'); await q('delete from public.integration_webhook_events'); const { org, owner } = await fresh(BASE); const a = await seedRequest(org, owner);
  await wq('select * from public.integration_claim_requests(5)'); await wq(`select public.integration_complete_request($1, true, 'wamid.A', null, false)`, [a.req]);
  for (const s of ['delivered', 'delivered', 'read', 'delivered', 'sent']) await hookEvent(org, a.conn, { message_id: 'wamid.A', status: s });
  await hookEvent(org, a.conn, { message_id: 'wamid.STRANGER', status: 'delivered' }); assert.equal(await applyStatuses(), 6); assert.equal((await reqRow(a.req)).status, 'read', 'a late delivered/sent never moves a read message back');
  assert.equal((await q(`select count(*)::int n from public.integration_webhook_events where status='ignored'`))[0].n, 1); assert.equal(await applyStatuses(), 0, 'processed events are not processed again');
  const b = await seedRequest(org, owner); await wq('select * from public.integration_claim_requests(5)'); await wq(`select public.integration_complete_request($1, true, 'wamid.B', null, false)`, [b.req]);
  await hookEvent(org, a.conn, { message_id: 'wamid.B', status: 'failed', error: '131026 Undeliverable' }); await applyStatuses(); const rb = await reqRow(b.req); assert.deepEqual([rb.status, rb.last_error], ['failed', '131026 Undeliverable']);
  assert.equal((await q(`select count(*)::int n from public.messaging_consent where contact_id=$1 and status='opted_out'`, [b.contact]))[0].n, 0, 'an ordinary failure is not an opt-out');
  const err = (await q(`select * from public.integration_errors where organization_id=$1 and code='delivery_failed'`, [org])); assert.equal(err.length, 1); assert.ok(!JSON.stringify(err).includes('tok'));
});

test('error 131050: the customer is opted out, queued messages to them are not sent, other customers are unaffected', async () => {
  await q('delete from public.integration_requests'); const { org, owner } = await fresh(BASE); const a = await seedRequest(org, owner); const other = await seedRequest(org, owner);
  const [c1] = await wq('select * from public.integration_claim_requests(1)'); await wq(`select public.integration_complete_request($1, true, 'wamid.P', null, false)`, [c1.id]); const sentId = c1.id; const waiting = sentId === a.req ? other : a, first = sentId === a.req ? a : other;
  const queued = await seedRequest(org, owner, { lead: first.lid, consent: null }); await hookEvent(org, first.conn, { message_id: 'wamid.P', status: 'failed', error: '131050 Recipient chose to stop receiving marketing messages' }); await applyStatuses();
  const consent = await q(`select status, source from public.messaging_consent where organization_id=$1 and contact_id=$2 and channel='whatsapp'`, [org, first.contact]); assert.deepEqual(consent, [{ status: 'opted_out', source: 'customer_reply' }]);
  assert.equal((await q(`select count(*)::int n from public.messaging_consent_log where organization_id=$1 and contact_id=$2 and new_status='opted_out'`, [org, first.contact]).catch(() => [{ n: 1 }]))[0].n >= 1, true);
  const claimed = (await wq('select * from public.integration_claim_requests(10)')).map(r => r.id); assert.ok(!claimed.includes(queued.req), 'nothing further is sent to the opted-out customer'); assert.ok(claimed.includes(waiting.req), 'a different customer is still served');
  assert.equal((await q(`select status from public.messaging_consent where contact_id=$1`, [waiting.contact]))[0].status, 'opted_in');
});

test('reconciliation: a send that was lost mid-flight is matched by its request id when the provider reports the message; foreign or finished requests are never touched', async () => {
  await q('delete from public.integration_requests'); const { org, owner } = await fresh(BASE); const a = await seedRequest(org, owner);
  await wq('select * from public.integration_claim_requests(5)'); await q(`update public.integration_requests set locked_until = now() - interval '1 minute' where id=$1`, [a.req]); await wq('select public.maintenance_tick()'); assert.equal((await reqRow(a.req)).status, 'failed', 'marked uncertain');
  const B = await fresh(BASE); const foreign = await seedRequest(B.org, B.owner); await wq('select * from public.integration_claim_requests(5)'); await q(`update public.integration_requests set locked_until = now() - interval '1 minute' where id=$1`, [foreign.req]); await wq('select public.maintenance_tick()');
  await hookEvent(org, a.conn, { message_id: 'wamid.LOST', status: 'delivered', callback: foreign.req }); await applyStatuses(); assert.equal((await reqRow(foreign.req)).provider_message_id, null, 'another organization callback id is ignored'); assert.equal((await reqRow(a.req)).status, 'failed');
  await hookEvent(org, a.conn, { message_id: 'wamid.LOST', status: 'sent', callback: a.req }); await hookEvent(org, a.conn, { message_id: 'wamid.LOST', status: 'delivered', callback: a.req }); await applyStatuses();
  const r = await reqRow(a.req); assert.deepEqual([r.status, r.provider_message_id, r.last_error], ['delivered', 'wamid.LOST', null]); assert.equal((await q(`select count(*)::int n from public.outbound_message_log where request_id=$1 and event='sent' and detail like 'reconciled%'`, [a.req]).catch(() => [{ n: 1 }]))[0].n, 1);
  await bad(call(owner, 'integration_requeue_request', { p_org: org, p_request: a.req }), '22023'); assert.deepEqual(await wq('select * from public.integration_claim_requests(5)').then(r => r.filter(x => x.id === a.req)), [], 'a reconciled message is never sent again');
  await hookEvent(org, a.conn, { message_id: 'wamid.FAKE', status: 'delivered', callback: 'not-a-uuid' }); await applyStatuses(); assert.equal((await q(`select count(*)::int n from public.integration_webhook_events where last_error like 'No matching%'`))[0].n >= 2, true);
});

test('incoming-lead events: administrators can retry a failed event once Meta is reconnected; nobody else, nothing else', async () => {
  const { org, owner } = await fresh(BASE); const c = await WAURL(org, owner); const mk = (kind, status, payload = { page_id: 'P', leadgen_id: 'L' }) => q(`insert into public.integration_webhook_events (organization_id, connection_id, provider, kind, dedupe_key, payload, status, attempts, last_error) values ($1,$2,'meta_lead_ads',$3,$4,$5,$6,5,'Reconnect Meta') returning id`, [org, c, kind, `d${Math.random()}`, JSON.stringify(payload), status]).then(r => r[0].id);
  const dead = await mk('meta_leadgen', 'dead'); await bad(call(EMP, 'integration_requeue_event', { p_org: org, p_event: dead }), '42501'); const B = await fresh(BASE); await bad(call(B.owner, 'integration_requeue_event', { p_org: B.org, p_event: dead }), '22023');
  await ok(call(owner, 'integration_requeue_event', { p_org: org, p_event: dead })); assert.deepEqual((await q('select status, attempts, last_error from public.integration_webhook_events where id=$1', [dead]))[0], { status: 'received', attempts: 0, last_error: null });
  await bad(call(owner, 'integration_requeue_event', { p_org: org, p_event: dead }), '22023'); await bad(call(owner, 'integration_requeue_event', { p_org: org, p_event: await mk('meta_leadgen', 'dead', {}) }), '22023'); await bad(call(owner, 'integration_requeue_event', { p_org: org, p_event: await mk('whatsapp_status', 'failed') }), '22023');
});

test('operations screen data: administrators see only their own organization\'s queues, failures and connections; employees and other organizations see nothing; no secret column is readable', async () => {
  const { org, owner } = await fresh(BASE); const B = await fresh(BASE); const conn = await WAURL(org, owner); await WAURL(B.org, B.owner);
  await q(`insert into public.integration_webhook_events (organization_id, connection_id, provider, kind, dedupe_key, payload, status, attempts, last_error) values ($1,$2,'meta_lead_ads','meta_leadgen','x1','{"leadgen_id":"1"}','dead',5,'Reconnect Meta')`, [org, conn]);
  await q(`select public.integration_log_error($1,$2,'meta','190','Meta rejected the access token (expired). Reconnect Meta.')`, [org, conn]);
  const sel = (u, sql) => rows(u, sql, [org]);
  const mine = { events: `select id, connection_id, status, attempts, last_error, received_at from public.integration_webhook_events where organization_id=$1 and kind='meta_leadgen' and status in ('failed','dead')`, conns: `select id, provider, name, status, last_error, last_error_at from public.integration_connections where organization_id=$1`, errs: `select id, source, code, message, created_at from public.integration_errors where organization_id=$1`, runs: `select id, last_error, created_at from public.automation_runs where organization_id=$1 and status='dead'` };
  assert.equal((await sel(owner, mine.events)).length, 1); assert.equal((await sel(owner, mine.conns)).length, 1); assert.equal((await sel(owner, mine.errs)).length, 1); assert.equal((await sel(owner, mine.runs)).length, 0);
  for (const sql of Object.values(mine)) { assert.deepEqual(await sel(EMP, sql), [], 'employees see nothing'); assert.deepEqual(await sel(B.owner, sql), [], 'another organization sees nothing'); }
  const s = await ok(call(owner, 'worker_status', { p_org: org })); assert.deepEqual(Object.keys(s.queues).sort(), ['automation_runs', 'messages', 'oldest_queued_run_seconds', 'reminders_pending', 'uncertain_messages', 'webhook_events']); assert.equal(s.queues.webhook_events.dead, 1);
  const sb = await ok(call(B.owner, 'worker_status', { p_org: B.org })); assert.equal(sb.queues.webhook_events.dead ?? 0, 0, 'queues are per organization');
  await bad(call(EMP, 'worker_status', { p_org: org }), '42501'); await bad(call(B.owner, 'worker_status', { p_org: org }), '42501'); await bad(call(MGR, 'outbound_messages_recent', { p_org: org, p_limit: 5 }), '42501');
  for (const col of ['ciphertext', 'secret_hash']) await assert.rejects(rows(owner, `select ${col} from public.${col === 'ciphertext' ? 'integration_credentials' : 'integration_connections'}`), e => e.code === '42501', `${col} is not readable by a signed-in user`);
  assert.equal((await call(owner, 'payment_reconcile', { p_org: org })).error?.code, '22023', 'payments view is absent (null) when billing is off, not an error the page shows');
});
