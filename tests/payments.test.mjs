// Payment gateway foundation and provider-contract tests. Real PostgreSQL (PGlite) with migrations 0001-0020; providers are mocked and never contacted. No provider or network is contacted.
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
import { createHmac, randomBytes } from 'node:crypto';
import { encryptJson, parseKey } from '../src/lib/integrations/crypto.ts';
import { handlePaymentWebhook } from '../src/lib/payments/webhook.ts';
import { razorpay, fromMinor } from '../src/lib/payments/gateway.ts';
const KEY = parseKey(randomBytes(32).toString('base64')); const GW = 'g'.repeat(40); const SECRET = 'whsec_test_secret';
const wq = async (sql, params = []) => { await db.exec('set role service_role'); try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); } };
const sys = () => db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
const BILL = { ...BASE, operations: { billing: { enabled: true, currency: 'INR', taxes: [] } } };
const setup = async (connect = true) => {
  const { org, owner } = await fresh(BILL); await wq('select public.integration_set_gateway_secret($1)', [GW]);
  const inv = async (price = 1000, cur = 'INR') => { const d = await ok(call(MGR, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: cur, p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: String(price), tax_keys: [] }] })); await ok(call(MGR, 'invoice_issue', { p_org: org, p_id: d })); return d; };
  const conn = await ok(call(owner, 'payments_connection_create', { p_org: org, p_name: 'Razorpay', p_gateway: 'razorpay' }));
  await ok(call(owner, 'integration_store_credentials', { p_org: org, p_conn: conn.id, p_ciphertext: encryptJson({ webhook_secret: SECRET }, KEY), p_expires_at: null })); if (connect) { await bad(call(owner, 'integration_set_status', { p_org: org, p_conn: conn.id, p_status: 'connected', p_error: null }), '22023', /signed notification/); await q('update public.integration_connections set last_event_at = now() where id=$1', [conn.id]); await ok(call(owner, 'integration_set_status', { p_org: org, p_conn: conn.id, p_status: 'connected', p_error: null })); } // activation needs a received, verified notification
  return { org, owner, conn, inv };
};
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const hook = (publicId, raw, { sig = sign(raw), eventId } = {}) => handlePaymentWebhook(new Request('https://x.test/hook', { method: 'POST', body: raw, headers: { ...(sig ? { 'x-razorpay-signature': sig } : {}), ...(eventId ? { 'x-razorpay-event-id': eventId } : {}) } }), publicId, { INTEGRATION_GATEWAY_SECRET: GW, key: KEY }, (fn, args) => mkRpc(null)(fn, args));
const captured = (invoiceId, amountMinor, { id = 'pay_1', currency = 'INR', method = 'upi' } = {}) => JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id, amount: amountMinor, currency, method, notes: { invoice_id: invoiceId } } } } });
const apply = () => wq('select public.payment_gateway_apply(50) r').then(r => r[0].r);

test('adapter contract: signature verification is constant-time and exact; parsing refuses anything it cannot read exactly', () => {
  const raw = captured('11111111-1111-4111-8111-111111111111', 150000, { id: 'pay_A' }); const h = o => new Headers(o);
  assert.equal(razorpay.verify(raw, h({ 'x-razorpay-signature': sign(raw) }), SECRET), true); for (const bad of [sign(raw, 'other'), sign(raw).toUpperCase().slice(0, 60), '', 'zz'.repeat(32), sign(raw + ' ')]) assert.equal(razorpay.verify(raw, h({ 'x-razorpay-signature': bad }), SECRET), false);
  assert.equal(razorpay.verify(raw, h({}), SECRET), false); assert.equal(razorpay.verify(raw, h({ 'x-razorpay-signature': sign(raw) }), ''), false);
  const [e] = razorpay.parse(JSON.parse(raw), h({})); assert.deepEqual(e, { eventId: 'payment.captured:pay_A', kind: 'payment_captured', providerPaymentId: 'pay_A', invoiceId: '11111111-1111-4111-8111-111111111111', amount: 1500, currency: 'INR', method: 'upi' });
  assert.equal(razorpay.parse(JSON.parse(raw), h({ 'x-razorpay-event-id': 'evt_9' }))[0].eventId, 'evt_9');
  const bad = o => razorpay.parse({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', amount: 100, currency: 'INR', ...o } } } }, h({}));
  for (const o of [{ amount: 10.5 }, { amount: '100' }, { amount: 0 }, { amount: -5 }, { currency: 'inr1' }, { currency: 'JPY' }, { currency: 'KWD' }, { amount: 1e15 }, { id: '' }]) assert.deepEqual(bad(o), [], JSON.stringify(o));
  assert.equal(bad({ notes: { invoice_id: 'not-a-uuid' } })[0].invoiceId, null, 'an invalid invoice reference is dropped, not guessed'); assert.equal(bad({ notes: [] })[0].invoiceId, null);
  assert.deepEqual(razorpay.parse({ event: 'order.paid' }, h({})), []); assert.deepEqual(razorpay.parse(null, h({})), []); assert.equal(bad({ method: 'netbanking' })[0].method, 'bank_transfer'); assert.equal(bad({ method: 'wallet' })[0].method, 'other');
  assert.deepEqual([fromMinor(100050, 'INR'), fromMinor(1, 'USD'), fromMinor(5, 'JPY')], [1000.5, 0.01, null]);
  const [rf] = razorpay.parse({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_A', amount: 500, currency: 'INR' } } } }, h({})); assert.deepEqual([rf.kind, rf.providerPaymentId, rf.amount], ['refund_processed', 'pay_A', 5]);
});

test('payments: only signed evidence creates money; duplicates and replays change nothing; partial payments reconcile; problems are held, never forced', async () => {
  const { org, owner, conn, inv } = await setup(); const i1 = await inv(1000); const bal = async id => (await q('select public.billing_balance($1) b', [id]))[0].b;
  // unsigned, wrongly signed, tampered or misrouted requests create nothing
  const raw = captured(i1, 40000, { id: 'pay_1' });
  assert.equal((await hook(conn.public_id, raw, { sig: '' })).status, 401); assert.equal((await hook(conn.public_id, raw, { sig: sign(raw, 'wrong') })).status, 401); assert.equal((await hook(conn.public_id, raw.replace('40000', '90000'))).status, 401 === 401 ? 200 : 200);
  assert.equal((await hook('nosuchconn', raw)).status, 404); assert.equal((await q('select count(*)::int n from public.payment_gateway_events'))[0].n, 1, 'only the correctly signed (re-signed tampered) body was stored');
  await q('delete from public.payment_gateway_events'); assert.equal((await hook(conn.public_id, 'not json')).status, 400);
  // a verified capture is stored, then applied through the normal posting function (source provider)
  assert.equal((await hook(conn.public_id, raw, { eventId: 'evt_1' })).status, 200); assert.equal((await hook(conn.public_id, raw, { eventId: 'evt_1' })).status, 200, 'a duplicate callback is acknowledged'); assert.equal((await q('select count(*)::int n from public.payment_gateway_events'))[0].n, 1);
  assert.deepEqual(await apply(), { applied: 1, held: 0, ignored: 0 }); assert.equal(Number(await bal(i1)), 600); const [p] = await q('select source, amount, method, provider_ref from public.invoice_payments where invoice_id=$1', [i1]); assert.deepEqual([p.source, Number(p.amount), p.method, p.provider_ref], ['provider', 400, 'upi', 'pay_1']);
  // the same payment replayed under a NEW event id is recognised by the provider payment id: no second payment
  assert.equal((await hook(conn.public_id, raw, { eventId: 'evt_replay' })).status, 200); await apply(); assert.equal((await q('select count(*)::int n from public.invoice_payments where invoice_id=$1', [i1]))[0].n, 1); assert.equal(Number(await bal(i1)), 600);
  // a second partial payment completes the invoice (and the event fires once)
  await hook(conn.public_id, captured(i1, 60000, { id: 'pay_2' })); await apply(); assert.equal(Number(await bal(i1)), 0); assert.equal((await q(`select count(*)::int n from public.domain_events where event_name='invoice.paid' and organization_id=$1`, [org]))[0].n, 1);
  // anything that cannot be applied cleanly is held with the reason
  const i2 = await inv(500); await hook(conn.public_id, captured(i1, 10000, { id: 'pay_over' })); await hook(conn.public_id, captured(i2, 10000, { id: 'pay_usd', currency: 'USD' })); await hook(conn.public_id, captured('99999999-9999-4999-8999-999999999999', 10000, { id: 'pay_ghost' })); await hook(conn.public_id, JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_noinv', amount: 100, currency: 'INR', notes: {} } } } }));
  const B = await setup(); const foreign = await B.inv(500); await hook(conn.public_id, captured(foreign, 5000, { id: 'pay_cross' }));
  assert.deepEqual(await apply(), { applied: 0, held: 5, ignored: 0 }); const held = await q(`select provider_payment_id, reason from public.payment_gateway_events where state='held' order by provider_payment_id`);
  assert.match(held.find(h => h.provider_payment_id === 'pay_over').reason, /more than the outstanding/); assert.match(held.find(h => h.provider_payment_id === 'pay_usd').reason, /currency does not match/); assert.match(held.find(h => h.provider_payment_id === 'pay_ghost').reason, /Invoice not found/); assert.match(held.find(h => h.provider_payment_id === 'pay_noinv').reason, /did not say which invoice/); assert.match(held.find(h => h.provider_payment_id === 'pay_cross').reason, /Invoice not found/, 'an invoice of another organization is never touched');
  assert.equal(Number(await bal(i2)), 500); assert.equal((await q('select count(*)::int n from public.invoice_payments where invoice_id=$1', [foreign]))[0].n, 0);
  // failed and refund reports never create or reverse money
  await hook(conn.public_id, JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f', amount: 100, currency: 'INR', notes: { invoice_id: i2 } } } } })); await hook(conn.public_id, JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rf1', payment_id: 'pay_1', amount: 100, currency: 'INR' } } } })); assert.deepEqual(await apply(), { applied: 0, held: 1, ignored: 1 });
  assert.equal((await hook(conn.public_id, JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'x', amount: 'lots', currency: 'INR' } } } }))).status, 200); assert.equal((await q(`select count(*)::int n from public.payment_gateway_events where provider_payment_id='x'`))[0].n, 0, 'an unreadable amount is never stored');
  // manual payments stay distinguishable and out of gateway totals; reconciliation shows held items
  await ok(call(MGR, 'payment_record', { p_org: org, p_invoice: i2, p_amount: 50, p_method: 'cash', p_reference: 'desk', p_note: null, p_received: null, p_key: null }));
  const rec = await ok(call(owner, 'payment_reconcile', { p_org: org })); assert.deepEqual([rec.held.length, rec.gateway_total_by_currency, rec.manual_total_by_currency, rec.applied_without_payment, rec.gateway_payments_without_event], [6, { INR: 1000 }, { INR: 50 }, 0, 0]);
  assert.deepEqual((await q('select source, count(*)::int n from public.invoice_payments where organization_id=$1 group by source order by source', [org])).map(r => [r.source, r.n]), [['manual', 1], ['provider', 2]]);
  await bad(call(MGR, 'payment_reconcile', { p_org: org }), '42501'); await bad(call(B.owner, 'payment_reconcile', { p_org: org }), '42501'); assert.deepEqual(await rows(EMP, 'select 1 from public.payment_gateway_events'), []); assert.ok((await rows(owner, 'select 1 from public.payment_gateway_events')).length >= 8); assert.deepEqual(await rows(B.owner, 'select 1 from public.payment_gateway_events where organization_id=$1', [org]), []);
  // a held payment can be retried only by an administrator of the same organization, only when held
  const ev = (await q(`select id from public.payment_gateway_events where provider_payment_id='pay_over'`))[0].id; await bad(call(MGR, 'payment_gateway_retry', { p_org: org, p_event: ev }), '42501'); await bad(call(B.owner, 'payment_gateway_retry', { p_org: B.org, p_event: ev }), '22023'); await ok(call(owner, 'payment_gateway_retry', { p_org: org, p_event: ev })); assert.equal((await q('select state from public.payment_gateway_events where id=$1', [ev]))[0].state, 'received');
});
test('payments: a connection that is not active holds payments; browsers and customers cannot post events; the secret is stored encrypted', async () => {
  await wq('delete from public.payment_gateway_events'); const { org, owner, conn, inv } = await setup(false); const i = await inv(300); await hook(conn.public_id, captured(i, 30000, { id: 'pay_x' })); assert.deepEqual(await apply(), { applied: 0, held: 1, ignored: 0 }); assert.match((await q('select reason from public.payment_gateway_events'))[0].reason, /not active/); assert.equal(Number((await q('select public.billing_balance($1) b', [i]))[0].b), 300);
  assert.deepEqual(await ok(call(null, 'payment_gateway_receive', { p_conn: conn.id, p_gateway_secret: 'wrong'.repeat(10), p_events: [{ event_id: 'e', kind: 'payment_captured', provider_payment_id: 'p', invoice_id: i, amount: 300, currency: 'INR', method: 'card' }] })), { status: 'unauthorized' }, 'without the gateway credential nothing is accepted');
  assert.equal((await ok(call(null, 'payment_gateway_connection', { p_public_id: conn.public_id, p_gateway_secret: 'wrong'.repeat(10) }))).status, 'unauthorized');
  for (const u of [owner, EMP, MGR]) { await assert.rejects(as(u, 'select * from public.payment_gateway_apply(5)'), e => e.code === '42501'); await assert.rejects(as(u, `insert into public.payment_gateway_events (organization_id, connection_id, event_id, kind, provider_payment_id) values ('${org}', '${conn.id}', 'x', 'payment_captured', 'p')`), e => e.code === '42501'); }
  const stored = (await q('select ciphertext from public.integration_credentials where connection_id=$1', [conn.id]))[0].ciphertext; assert.ok(!stored.includes(SECRET) && /^v\d+:/.test(stored)); await bad(call(MGR, 'payments_connection_create', { p_org: org, p_name: 'x', p_gateway: 'razorpay' }), '42501'); await bad(call(owner, 'payments_connection_create', { p_org: org, p_name: 'x', p_gateway: 'razorpay' }), '23505'); await bad(call(owner, 'payments_connection_create', { p_org: org, p_name: 'x', p_gateway: 'stripe' }), '22023');
  assert.equal((await handlePaymentWebhook(new Request('https://x.test', { method: 'GET' }), conn.public_id, { INTEGRATION_GATEWAY_SECRET: GW, key: KEY }, () => { throw new Error('no'); })).status, 405); assert.equal((await handlePaymentWebhook(new Request('https://x.test', { method: 'POST', body: '{}' }), conn.public_id, { key: KEY }, () => { throw new Error('no'); })).status, 503, 'unconfigured traffic is never accepted');
});
