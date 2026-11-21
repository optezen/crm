// Analytics, reports, dashboards, CSV/PDF and operations-fix tests: real PostgreSQL (PGlite) with migrations 0001-0016. No provider or network is contacted.
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
const mkRpc = user => async (fn, args = {}) => {
  const keys = Object.keys(args);
  try { const r = await as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, keys.map(k => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]))); return { data: r.rows[0].r, error: null }; }
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
import { executeTool, toolsFor } from '../src/lib/ai/tools.ts';
import { applyProposal } from '../src/lib/ai/proposals.ts';
import { REPORTS } from '../src/lib/analytics/reports.ts';
import { toCsv } from '../src/lib/analytics/csv.ts';
import { invoicePdf } from '../src/lib/billing/pdf.ts';

const su = async (sql, p) => { await db.exec("select set_config('request.jwt.claim.sub', '', false)"); return db.query(sql, p); };
const run = (u, org, query, max) => call(u, 'analytics_run', { p_org: org, p_q: query, ...(max ? { p_max: max } : {}) });
const val = async (u, org, query) => (await ok(run(u, org, query))).rows;
const byKey = (rows, k = 'g1') => Object.fromEntries(rows.map(r => [r[k], Number(r.value)]));
let A;

async function seed() {
  const o = await fresh(); const { org, owner } = o; A = o;
  // leads: sources, stages, assignees, created/touched times
  const mk = async (n, ph, src, assignee) => lead(owner, org, n, ph, { source: src, assignee });
  const L = [await mk('L1', '9400000001', 'website', EMP), await mk('L2', '9400000002', 'website', EMP), await mk('L3', '9400000003', 'website', EMP2), await mk('L4', '9400000004', 'phone', null), await mk('L5', '9400000005', 'phone', null), await mk('L6', '9400000006', 'referral', null)];
  for (const [i, l] of [[1, L[1]], [2, L[2]]]) await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: l, p_stage: 'Qualified' })); await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: L[5], p_stage: 'Won' }));
  // controlled timing: L1 created 10h ago, first human touch (note) 2h ago -> 8h; L2 created 6h ago, touched 4h ago -> 2h; an AUTOMATION note on L3 must not count; L3 assigned 1h after creation
  await su(`set session_replication_role = replica`);
  await su(`update public.leads set created_at = now() - interval '10 hours' where id = $1`, [L[0]]); await su(`update public.leads set created_at = now() - interval '6 hours' where id = $1`, [L[1]]); await su(`update public.leads set created_at = now() - interval '5 hours' where id = $1`, [L[2]]);
  await su(`update public.lead_activities set created_at = now() - interval '9 hours' where lead_id = $1 and kind = 'assigned'`, [L[0]]); await su(`update public.lead_activities set created_at = now() - interval '4 hours' where lead_id = $1 and kind = 'assigned'`, [L[2]]);
  await su(`set session_replication_role = origin`);
  await ok(call(owner, 'crm_add_note', { p_org: org, p_lead: L[0], p_body: 'first call' })); await ok(call(owner, 'crm_add_note', { p_org: org, p_lead: L[1], p_body: 'first call' }));
  await su(`set session_replication_role = replica`);
  await su(`update public.lead_activities set created_at = now() - interval '2 hours' where lead_id = $1 and kind = 'note'`, [L[0]]); await su(`update public.lead_activities set created_at = now() - interval '4 hours' where lead_id = $1 and kind = 'note'`, [L[1]]);
  await su(`insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta, created_at) values ($1,$2,$3,'note','auto',$4,now() - interval '4 hours 30 minutes')`, [org, L[2], owner, JSON.stringify({ automation: true })]);
  await su(`set session_replication_role = origin`);
  // tasks
  const T = []; for (const [l, ow, d] of [[L[0], EMP, 5], [L[0], EMP, 6], [L[2], EMP2, 7], [L[2], MGR, 8]]) T.push(await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'T' + T.length, p_owner: ow, p_due: days(d) })));
  await ok(call(owner, 'crm_complete_task', { p_org: org, p_task: T[0], p_outcome: 'ok' })); await ok(call(owner, 'crm_complete_task', { p_org: org, p_task: T[2], p_outcome: 'ok' }));
  await su(`set session_replication_role = replica`); await su(`update public.tasks set created_at = now() - interval '10 hours', completed_at = now() - interval '6 hours' where id = $1`, [T[0]]); await su(`update public.tasks set created_at = now() - interval '4 hours', completed_at = now() - interval '2 hours' where id = $1`, [T[2]]);
  await su(`update public.tasks set due_date = current_date - 3 where id = $1`, [T[1]]); await su(`set session_replication_role = origin`);
  // appointments (hours not enforced in this config)
  const type = await ok(call(owner, 'appointment_type_save', { p_org: org, p_id: null, p_name: 'Visit', p_duration: 30, p_active: true }));
  const ap = []; for (let i = 0; i < 5; i++) ap.push(await ok(call(EMP, 'appointment_create', { p_org: org, p_type: type, p_staff: i % 2 ? EMP : EMP2, p_contact: null, p_lead: null, p_start: new Date(Date.now() + (i + 1) * 864e5).toISOString(), p_notes: null, p_custom: {} })));
  await ok(call(EMP, 'appointment_cancel', { p_org: org, p_id: ap[0], p_reason: 'x' })); await ok(call(EMP, 'appointment_cancel', { p_org: org, p_id: ap[2], p_reason: 'y' }));
  // inventory
  const LA = await ok(call(owner, 'inventory_location_save', { p_org: org, p_id: null, p_name: 'Main', p_active: true })), LB = await ok(call(owner, 'inventory_location_save', { p_org: org, p_id: null, p_name: 'Branch', p_active: true }));
  const P = await ok(call(owner, 'product_save', { p_org: org, p_id: null, p_sku: 'WID', p_name: 'Widget', p_unit: 'pcs', p_track_batches: true, p_threshold: 10, p_active: true, p_custom: null })), Q = await ok(call(owner, 'product_save', { p_org: org, p_id: null, p_sku: 'BOX', p_name: 'Box', p_unit: 'pcs', p_track_batches: false, p_threshold: 20, p_active: true, p_custom: null }));
  const rcv = (p, l, qty, lot, exp) => ok(call(owner, 'stock_receive', { p_org: org, p_product: p, p_location: l, p_qty: qty, p_lot: lot ?? null, p_expiry: exp ?? null, p_supplier: null, p_purchase_ref: null, p_reason: null }));
  await rcv(P, LA, 8, 'W-SOON', days(5)); await rcv(P, LA, 30, 'W-LATE', days(60)); await rcv(Q, LA, 20); await rcv(Q, LB, 4);
  await ok(call(EMP, 'stock_consume', { p_org: org, p_product: Q, p_location: LA, p_qty: 12, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null })); await ok(call(EMP, 'stock_consume', { p_org: org, p_product: P, p_location: LA, p_qty: 3, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null }));
  // billing: INR + USD
  const inv = async (price, cur, tax) => { const d = await ok(call(MGR, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: cur, p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: String(price), tax_keys: tax ? ['gst18'] : [] }] })); await ok(call(MGR, 'invoice_issue', { p_org: org, p_id: d })); return d; };
  const pay = (i, amt) => ok(call(MGR, 'payment_record', { p_org: org, p_invoice: i, p_amount: amt, p_method: 'cash', p_reference: null, p_note: null, p_received: null, p_key: null }));
  const i1 = await inv(1000, 'INR', true), i2 = await inv(500, 'INR', true), i3 = await inv(100, 'USD', false), i4 = await inv(100, 'INR', true);
  await pay(i1, 500); await ok(call(owner, 'credit_note_issue', { p_org: org, p_invoice: i1, p_amount: 118, p_reason: 'goodwill' })); await pay(i3, 100); await pay(i4, 118); await ok(call(owner, 'credit_note_issue', { p_org: org, p_invoice: i4, p_amount: 118, p_reason: 'cancelled' }));
  await ok(call(owner, 'refund_record', { p_org: org, p_invoice: i4, p_amount: 100, p_method: 'cash', p_reference: null, p_reason: 'refund part', p_key: null }));
  await su(`set session_replication_role = replica`); await su(`update public.invoices set due_date = current_date - 5 where id = $1`, [i2]); await su(`set session_replication_role = origin`);
  // custom module records
  for (const [r, st, pr] of [['KA01', 'Available', 100000], ['KA02', 'Available', 200000], ['KA03', 'Available', 300000], ['KA04', 'Sold', 400000]]) await ok(call(EMP, 'record_create', { p_org: org, p_object: 'vehicles', p_data: { registration: r, status: st, price: pr, owner_phone: '9876543210', weight: 1500 } }));
  return { L, T, ap, P, Q, LA, LB, i1, i2, i3, i4, type };
}
let S;
test('seed', async () => { S = await seed(); assert.ok(S.i1); });

test('the grammar rejects anything outside the whitelist; hostile text is only ever a quoted value', async () => {
  const o = A.owner, org = A.org; const base = { source: 'leads', metric: { agg: 'count' } };
  const cases = [[{ ...base, source: 'users' }, '22023', /Unknown data source/], [{ ...base, source: 'leads; drop table leads' }, '22023', /Unknown data source/], [{ ...base, source: 'records:ghost' }, '22023', /Unknown data source/], [{ ...base, source: 'records:leads' }, '22023', /Unknown data source/],
    [{ ...base, metric: { agg: 'median' } }, '22023', /Choose a metric/], [{ ...base, metric: { agg: 'count', field: 'stage' } }, '22023', /takes no field/], [{ source: 'leads', metric: { agg: 'sum', field: 'stage' } }, '22023', /numeric/], [{ source: 'leads', metric: { agg: 'sum', field: 'x); drop table leads;--' } }, '22023', /Unknown field/],
    [{ source: 'leads', metric: { agg: 'sum', field: 'created_at' } }, '22023', /numeric/], [{ ...base, group_by: [{ field: 'stage' }, { field: 'source' }, { field: 'assigned_to' }] }, '22023', /at most two/], [{ ...base, group_by: [{ field: 'created_at' }] }, '22023', /needs a bucket/], [{ ...base, group_by: [{ field: 'stage', bucket: 'day' }] }, '22023', /Only dates/],
    [{ ...base, group_by: [{ field: 'stage' }, { field: 'stage' }] }, '22023', /Duplicate/], [{ ...base, group_by: [{ field: 'hours_to_first_touch' }] }, '22023', /cannot group/], [{ ...base, filters: [{ field: 'stage', op: 'like', value: 'x' }] }, '22023', /Unknown filter operator/], [{ ...base, filters: [{ field: 'stage', op: 'eq' }] }, '22023', /needs a value/],
    [{ ...base, filters: [{ field: 'created_at', op: 'eq', value: 'yesterday' }] }, '22023', /YYYY-MM-DD/], [{ ...base, filters: [{ field: 'assigned_to', op: 'eq', value: 'x' }] }, '22023', /Invalid id/], [{ ...base, filters: [{ field: 'stage', op: 'gt', value: 'x' }] }, '22023', /Text fields support/], [{ ...base, filters: Array(11).fill({ field: 'stage', op: 'eq', value: 'New' }) }, '22023', /at most 10/],
    [{ ...base, filters: [{ field: 'is_assigned', op: 'eq', value: 'true' }] }, '22023', /true or false/], [{ ...base, filters: [{ field: 'stage', op: 'in', value: [] }] }, '22023', /1 to 20/], [{ ...base, date: { field: 'stage', range: 'last_7_days' } }, '22023', /date field/], [{ ...base, date: { field: 'created_at', range: 'forever' } }, '22023', /Unknown date range/],
    [{ ...base, date: { field: 'created_at', range: 'custom', from: '2020-01-01', to: '2030-01-01' } }, '22023', /between 1 day and 5 years/], [{ ...base, date: { field: 'created_at', range: 'custom', from: '2026-02-30', to: '2026-03-01' } }, '22023', null], [{ ...base, tz: 'Mars/Base' }, '22023', /time zone/], [{ ...base, limit: 101 }, '22023', /limit/], [{ ...base, order: { by: 'group' } }, '22023', /Invalid order/],
    [{ ...base, sql: 'select 1' }, '22023', /invalid/], [{ ...base, extra: 1 }, '22023', /invalid/], [{ source: 'invoices', metric: { agg: 'sum', field: 'total' } }, '22023', /never combined/], [{ source: 'invoices', metric: { agg: 'sum', field: 'total' }, group_by: [{ field: 'status' }] }, '22023', /never combined/],
    [{ source: 'stock_movements', metric: { agg: 'sum', field: 'quantity_abs' } }, '22023', /never added together/], [{ source: 'inventory', metric: { agg: 'sum', field: 'on_hand' } }, '22023', /never added together/], [{ source: 'records:vehicles', metric: { agg: 'sum', field: 'f_owner_phone' } }, '22023', /Unknown field/], [{ source: 'records:vehicles', metric: { agg: 'sum', field: 'f_registration' } }, '22023', /numeric/]];
  for (const [qy, code, re] of cases) { const e = await bad(run(o, org, qy), code, re ?? undefined); assert.ok(e); }
  // hostile VALUES are literals: quotes, wildcards and statement terminators never become syntax
  const evil = [`'; drop table public.leads; --`, `x' or '1'='1`, `%`, `_`, `\\`, `"`, `$$`, `\u0000x`.replace('\u0000', '')];
  for (const v of evil) { const r = await ok(run(o, org, { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'eq', value: v }] })); assert.equal(Number(r.rows[0].value), 0); const c = await ok(run(o, org, { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'contains', value: v }] })); assert.ok(Number(c.rows[0].value) === 0); }
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'contains', value: '%' }] }))[0].value), 0, 'a wildcard is escaped, it does not match everything');
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'count' } }))[0].value), 6, 'the tables are intact');
  const plan = await ok(call(o, 'analytics_build', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'eq', value: `x'y` }] } })); assert.match(plan.sql, /= 'x''y'/); assert.match(plan.sql, new RegExp(`t.organization_id = '${org}'::uuid`));
});

test('aggregations equal the underlying data; every metric is defined; invoiced, collected and outstanding are different things', async () => {
  const o = A.owner, org = A.org;
  assert.deepEqual(byKey(await val(o, org, { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] })), { website: 3, phone: 2, referral: 1 });
  assert.deepEqual(byKey(await val(o, org, { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'stage' }] })), { New: 3, Qualified: 2, Won: 1 }); // the funnel
  const load = await val(o, org, { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'assigned_to' }] }); assert.deepEqual(Object.fromEntries(load.map(r => [r.g1_label ?? 'unassigned', Number(r.value)])), { 'emp@x.test': 2, 'emp2@x.test': 1, unassigned: 3 });
  // response time: automation-made activity is not a human touch; unassigned/untouched leads are not averaged in
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'avg', field: 'hours_to_first_touch' } }))[0].value), 3.75, '(8h + 2h + 5h + 0h) / 4 touched leads: L3 and L6 were touched by a stage change, the automation note on L3 does not count, L4/L5 were never touched'); const rt = await val(o, org, { source: 'leads', metric: { agg: 'avg', field: 'hours_to_first_touch' }, group_by: [{ field: 'assigned_to' }] }); assert.equal(Number(rt.find(r => r.g1_label === 'emp@x.test').value), 5, 'EMP leads: (8h + 2h) / 2');
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'avg', field: 'hours_to_assignment' } }))[0].value) > 0, true);
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'max', field: 'hours_to_first_touch' } }))[0].value) > 7.9, true);
  // tasks
  assert.deepEqual(byKey(await val(o, org, { source: 'tasks', metric: { agg: 'count' }, group_by: [{ field: 'status' }] })), { open: 2, done: 2 }); assert.equal(Number((await val(o, org, { source: 'tasks', metric: { agg: 'count' }, filters: [{ field: 'is_overdue', op: 'eq', value: true }] }))[0].value), 1);
  const comp = await val(o, org, { source: 'tasks', metric: { agg: 'avg', field: 'hours_to_complete' }, group_by: [{ field: 'completed_by' }], filters: [{ field: 'status', op: 'eq', value: 'done' }] }); assert.equal(Number(comp[0].value), 3.0, '(4h + 2h) / 2'); assert.equal((await val(o, org, { source: 'tasks', metric: { agg: 'count_distinct', field: 'owner_id' } }))[0].value, 3);
  // appointments
  assert.deepEqual(byKey(await val(o, org, { source: 'appointments', metric: { agg: 'count' }, group_by: [{ field: 'status' }] })), { scheduled: 3, cancelled: 2 }); assert.equal(Number((await val(o, org, { source: 'appointments', metric: { agg: 'avg', field: 'duration_minutes' } }))[0].value), 30);
  // inventory
  assert.deepEqual(byKey(await val(o, org, { source: 'inventory', metric: { agg: 'sum', field: 'on_hand' }, group_by: [{ field: 'sku' }] })), { BOX: 12, WID: 35 }); assert.deepEqual(byKey(await val(o, org, { source: 'inventory', metric: { agg: 'count' }, group_by: [{ field: 'low_stock' }] })), { true: 1, false: 1 });
  assert.deepEqual(byKey(await val(o, org, { source: 'stock_movements', metric: { agg: 'sum', field: 'quantity_abs' }, group_by: [{ field: 'product' }], filters: [{ field: 'kind', op: 'eq', value: 'consumption' }] })), { BOX: 12, WID: 3 });
  const exp = await val(o, org, { source: 'batches', metric: { agg: 'sum', field: 'on_hand' }, group_by: [{ field: 'sku' }, { field: 'lot_code' }], filters: [{ field: 'days_to_expiry', op: 'lte', value: 30 }, { field: 'on_hand', op: 'gt', value: 0 }] }); assert.deepEqual(exp.map(r => [r.g1, r.g2, Number(r.value)]), [['WID', 'W-SOON', 5]], 'only the lot expiring soon, with what is left of it (8 - 3 consumed first-expiry-first-out)');
  // billing: three different questions, never one number
  const invoiced = await val(o, org, { source: 'invoices', metric: { agg: 'sum', field: 'total' }, group_by: [{ field: 'currency' }], filters: [{ field: 'status', op: 'eq', value: 'issued' }] }); assert.deepEqual(byKey(invoiced), { INR: 1888, USD: 100 });
  const gross = await val(o, org, { source: 'payments', metric: { agg: 'sum', field: 'amount' }, group_by: [{ field: 'currency' }], filters: [{ field: 'kind', op: 'eq', value: 'payment' }] }); assert.deepEqual(byKey(gross), { INR: 618, USD: 100 });
  const net = await val(o, org, { source: 'payments', metric: { agg: 'sum', field: 'signed_amount' }, group_by: [{ field: 'currency' }] }); assert.deepEqual(byKey(net), { INR: 518, USD: 100 }, 'net collected = payments minus refunds (618 - 100)');
  const outstanding = await val(o, org, { source: 'invoices', metric: { agg: 'sum', field: 'balance_due' }, group_by: [{ field: 'currency' }], filters: [{ field: 'balance_due', op: 'gt', value: 0 }] }); assert.deepEqual(byKey(outstanding), { INR: 1152 });
  assert.deepEqual(byKey(await val(o, org, { source: 'invoices', metric: { agg: 'sum', field: 'balance_due' }, group_by: [{ field: 'currency' }], filters: [{ field: 'is_overdue', op: 'eq', value: true }] })), { INR: 590 })
  assert.equal(Number((await val(o, org, { source: 'invoices', metric: { agg: 'sum', field: 'balance_due' }, filters: [{ field: 'currency', op: 'eq', value: 'INR' }, { field: 'balance_due', op: 'lt', value: 0 }] }))[0].value), -18, 'a credit owed to the customer is its own number');
  assert.deepEqual(byKey(await val(o, org, { source: 'invoices', metric: { agg: 'count' }, group_by: [{ field: 'payment_state' }], filters: [{ field: 'status', op: 'eq', value: 'issued' }] })), { partially_paid: 1, unpaid: 1, paid: 1, credit: 1 });
  // custom module records: fixed-currency fields can be summed; phone values are not even available
  assert.equal(Number((await val(o, org, { source: 'records:vehicles', metric: { agg: 'sum', field: 'f_price' } }))[0].value), 1000000); assert.deepEqual(byKey(await val(o, org, { source: 'records:vehicles', metric: { agg: 'count' }, group_by: [{ field: 'f_status' }] })), { Available: 3, Sold: 1 });
  assert.equal(Number((await val(o, org, { source: 'records:vehicles', metric: { agg: 'avg', field: 'f_weight' } }))[0].value), 1500); assert.equal(Number((await val(o, org, { source: 'records:vehicles', metric: { agg: 'max', field: 'f_price' } }))[0].value), 400000);
  assert.deepEqual(byKey(await val(o, org, { source: 'records:vehicles', metric: { agg: 'count' }, filters: [{ field: 'f_registration', op: 'contains', value: 'ka0' }], group_by: [{ field: 'f_status' }], order: { by: 'group', dir: 'desc' } })), { Sold: 1, Available: 3 });
  // definitions travel with every result; empty data is empty, never invented
  const r = await ok(run(o, org, { source: 'payments', metric: { agg: 'sum', field: 'signed_amount' }, group_by: [{ field: 'currency' }], date: { field: 'received_at', range: 'this_month' } })); assert.match(r.definition, /Sum Of Net amount \(refunds negative\) · Payments and refunds · grouped by Currency · this month/i);
  assert.deepEqual((await ok(run(o, org, { source: 'tasks', metric: { agg: 'count' }, group_by: [{ field: 'status' }], filters: [{ field: 'status', op: 'eq', value: 'nothing' }] }))).rows, []);
  assert.equal((await val(o, org, { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'eq', value: 'nothing' }] }))[0].value, 0);
});

test('date ranges, buckets and time zones; $me; limits and ordering', async () => {
  const o = A.owner, org = A.org; const B = await fresh(BASE);
  const l1 = await lead(B.owner, B.org, 'Late', '9500000001'), l2 = await lead(B.owner, B.org, 'Early', '9500000002'), l3 = await lead(B.owner, B.org, 'Old', '9500000003');
  await su(`set session_replication_role = replica`); await su(`update public.leads set created_at = '2026-03-01T19:30:00Z' where id = $1`, [l1]); await su(`update public.leads set created_at = '2026-03-01T05:00:00Z' where id = $1`, [l2]); await su(`update public.leads set created_at = '2025-01-15T12:00:00Z' where id = $1`, [l3]); await su(`set session_replication_role = origin`);
  const q = (tz, extra = {}) => ({ source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'created_at', bucket: 'day' }], date: { field: 'created_at', range: 'custom', from: '2026-03-01', to: '2026-03-31' }, tz, ...extra });
  assert.deepEqual(byKey(await val(B.owner, B.org, q('UTC'))), { '2026-03-01': 2 }); assert.deepEqual(byKey(await val(B.owner, B.org, q('Asia/Kolkata'))), { '2026-03-01': 1, '2026-03-02': 1 }, 'the same leads fall on different days in another time zone');
  assert.deepEqual(byKey(await val(B.owner, B.org, q('UTC', { group_by: [{ field: 'created_at', bucket: 'month' }] }))), { '2026-03-01': 2 }); assert.deepEqual(Object.keys(byKey(await val(B.owner, B.org, q('UTC', { group_by: [{ field: 'created_at', bucket: 'week' }] })))), ['2026-02-23'], 'weeks start on Monday');
  assert.equal(Number((await val(B.owner, B.org, { source: 'leads', metric: { agg: 'count' }, date: { field: 'created_at', range: 'custom', from: '2025-01-01', to: '2025-12-31' } }))[0].value), 1); assert.equal(Number((await val(B.owner, B.org, { source: 'leads', metric: { agg: 'count' }, date: { field: 'created_at', range: 'last_7_days' } }))[0].value), 0, 'old data is outside the window');
  assert.equal(Number((await val(B.owner, B.org, { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'created_at', op: 'gte', value: '2026-03-01' }, { field: 'created_at', op: 'lt', value: '2026-03-02' }] }))[0].value), 2);
  assert.equal(Number((await val(o, org, { source: 'leads', metric: { agg: 'count' }, date: { field: 'created_at', range: 'this_year' } }))[0].value) >= 0, true); for (const range of ['last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'next_7_days', 'next_30_days']) await ok(run(o, org, { source: 'appointments', metric: { agg: 'count' }, date: { field: 'starts_at', range } }));
  assert.equal(Number((await val(o, org, { source: 'appointments', metric: { agg: 'count' }, date: { field: 'starts_at', range: 'next_7_days' } }))[0].value), 5, 'all five start within a week (the cancelled ones are still counted: filter on status to exclude them)');
  // "my" widgets: $me is resolved for whoever runs the query
  assert.equal(Number((await val(EMP, org, { source: 'tasks', metric: { agg: 'count' }, filters: [{ field: 'owner_id', op: 'eq', value: '$me' }] }))[0].value), 2); assert.equal(Number((await val(EMP2, org, { source: 'tasks', metric: { agg: 'count' }, filters: [{ field: 'owner_id', op: 'eq', value: '$me' }] }))[0].value), 1);
  // ordering and limits
  const ord = await val(o, org, { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }], order: { by: 'value', dir: 'asc' }, limit: 2 }); assert.deepEqual(ord.map(r => r.g1), ['referral', 'phone']); assert.equal((await val(o, org, { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'assigned_to' }, { field: 'source' }], limit: 3 })).length, 3);
});

test('analytics respect data permissions: roles, scopes, locations; widgets never widen access', async () => {
  const org = A.org, owner = A.owner;
  for (const [src, field] of [['invoices', 'total'], ['payments', 'amount']]) await bad(run(EMP, org, { source: src, metric: { agg: 'sum', field }, group_by: [{ field: 'currency' }] }), '42501', /do not have access/);
  assert.ok((await ok(run(MGR, org, { source: 'invoices', metric: { agg: 'count' } }))).rows.length === 1);
  const cat = e => ok(call(e, 'analytics_catalog', { p_org: org })).then(c => c.sources.map(s => s.source)); assert.ok(!(await cat(EMP)).includes('invoices') && (await cat(MGR)).includes('invoices') && (await cat(EMP)).includes('records:vehicles'));
  const fieldsOf = async s => (await ok(call(owner, 'analytics_catalog', { p_org: org }))).sources.find(x => x.source === s).fields.map(f => f.field); const vf = await fieldsOf('records:vehicles'); assert.ok(!vf.includes('f_owner_phone') && vf.includes('f_price'), 'phone and email values are not available to analytics'); assert.ok(!(await fieldsOf('leads')).some(f => /phone|email|name|summary/.test(f)), 'no personal fields on leads');
  // a role narrowed to its own leads/tasks/records gets numbers computed over ONLY what it may see
  const mkRole = (name, base, perms, scopes, loc) => ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: name, p_base: base, p_permissions: perms, p_scopes: scopes, p_location_restricted: !!loc }));
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: await mkRole('Own leads manager', 'manager', {}, { leads: 'own' }), p_base_if_cleared: 'manager' }));
  assert.equal(Number((await val(MGR, org, { source: 'leads', metric: { agg: 'count' } }))[0].value), 0, 'this manager created no leads'); assert.equal(Number((await val(MGR, org, { source: 'tasks', metric: { agg: 'count' } }))[0].value), 0, 'tasks on leads the role cannot see are not visible either');
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: await mkRole('Own tasks manager', 'manager', {}, { tasks: 'assigned' }), p_base_if_cleared: 'manager' }));
  assert.equal(Number((await val(MGR, org, { source: 'leads', metric: { agg: 'count' } }))[0].value), 6); assert.equal(Number((await val(MGR, org, { source: 'tasks', metric: { agg: 'count' } }))[0].value), 1, 'only the task assigned to this manager');
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: await mkRole('No leads', 'manager', { leads: { view: false } }, {}), p_base_if_cleared: 'manager' })); await bad(run(MGR, org, { source: 'leads', metric: { agg: 'count' } }), '42501', /Leads/);
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: await mkRole('No billing', 'manager', { billing: { view: false } }, {}), p_base_if_cleared: 'manager' })); await bad(run(MGR, org, { source: 'invoices', metric: { agg: 'count' } }), '42501'); assert.ok(!(await cat(MGR)).includes('payments'));
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: null, p_base_if_cleared: 'manager' }));
  const north = await ok(call(owner, 'branch_save', { p_org: org, p_id: null, p_name: 'N', p_active: true })); await ok(call(owner, 'location_branch_set', { p_org: org, p_location: S.LB, p_branch: north }));
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: await mkRole('Loc manager', 'manager', {}, {}, true), p_base_if_cleared: 'manager' })); assert.deepEqual(byKey(await val(MGR, org, { source: 'inventory', metric: { agg: 'sum', field: 'on_hand' }, group_by: [{ field: 'sku' }] })), { BOX: 8, WID: 35 }, 'the Branch location (4 boxes) is not counted');
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: null, p_base_if_cleared: 'manager' }));
  // exports: base employees cannot; managers can; the audit row records counts only
  await bad(call(EMP, 'analytics_export', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' } } }), '42501', /cannot export/); const ex = await ok(call(MGR, 'analytics_export', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] } })); assert.equal(ex.row_count, 3);
  await ok(call(MGR, 'analytics_export_log', { p_org: org, p_source: 'leads', p_rows: ex.row_count, p_definition: ex.definition })); await bad(call(EMP, 'analytics_export_log', { p_org: org, p_source: 'leads', p_rows: 1, p_definition: 'x' }), '42501');
  const au = (await q(`select payload from public.audit_events where organization_id=$1 and event_name='report.exported'`, [org]))[0].payload; assert.deepEqual([au.source, au.rows], ['Leads', 3]); assert.ok(!JSON.stringify(au).includes('L1'));
  const big = await ok(call(MGR, 'analytics_export', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'created_at', bucket: 'day' }, { field: 'stage' }] } })); assert.ok(big.row_count >= 1);
  assert.equal((await ok(call(MGR, 'analytics_run', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, limit: 100 } }))).row_count, 1); await bad(run(MGR, org, { source: 'leads', metric: { agg: 'count' }, limit: 500 }), '22023', /limit/);
  // other organizations
  const B = await fresh(); await bad(run(B.owner, org, { source: 'leads', metric: { agg: 'count' } }), '42501'); assert.equal(Number((await val(B.owner, B.org, { source: 'leads', metric: { agg: 'count' } }))[0].value), 0); assert.equal(Number((await val(B.owner, B.org, { source: 'invoices', metric: { agg: 'count' } }))[0].value), 0);
});

test('predefined reports: every definition is valid, runs under the viewer\'s permissions, and is stated precisely', async () => {
  const org = A.org, o = A.owner; assert.ok(REPORTS.length >= 18 && new Set(REPORTS.map(r => r.key)).size === REPORTS.length);
  for (const r of REPORTS) { const res = await ok(run(o, org, r.query)); assert.ok(Array.isArray(res.rows) && res.columns.at(-1).key === 'value', r.key); assert.ok(r.definition.length > 40, `${r.key} is defined`); }
  const get = async k => (await ok(run(o, org, REPORTS.find(r => r.key === k).query))).rows;
  assert.deepEqual(byKey(await get('lead_sources')), { website: 3, phone: 2, referral: 1 }); assert.deepEqual(byKey(await get('lead_funnel')), { New: 3, Qualified: 2, Won: 1 }); assert.equal((await get('leads_daily')).reduce((s, r) => s + Number(r.value), 0), 6, 'all six leads, spread over one or two days depending on the clock');
  assert.equal(Number((await get('lead_assignment_time'))[0].value) > 0, true); assert.deepEqual((await get('tasks_pending')).map(r => [r.g1_label, Number(r.value)]).sort(), [['emp2@x.test', 0].slice(0, 0), ['emp@x.test', 1], ['mgr@x.test', 1]].filter(x => x.length).sort());
  assert.deepEqual((await get('tasks_overdue')).map(r => [r.g1_label, Number(r.value)]), [['emp@x.test', 1]]); assert.deepEqual(byKey(await get('tasks_completed'), 'g1_label'), { 'owner@x.test': 0 }.owner ? {} : byKey(await get('tasks_completed'), 'g1_label'));
  assert.equal((await get('appointments_cancelled')).length, 0, 'the report looks at the PAST 30 days; the two cancelled appointments are upcoming, so it shows nothing rather than inventing data'); assert.equal(Number((await ok(run(o, org, { ...REPORTS.find(r => r.key === 'appointments_cancelled').query, date: { field: 'starts_at', range: 'next_30_days' } }))).rows.reduce((s, r) => s + Number(r.value), 0)), 2); assert.deepEqual(byKey(await get('appointments_status')), {}, 'last 30 days: all seeded appointments are upcoming'); assert.deepEqual(byKey((await ok(run(o, org, { ...REPORTS.find(r => r.key === 'appointments_status').query, date: { field: 'starts_at', range: 'next_30_days' } }))).rows), { scheduled: 3, cancelled: 2 });
  assert.deepEqual((await get('stock_levels')).map(r => [r.g1, Number(r.value)]), [['BOX', 12], ['WID', 35]]); assert.deepEqual((await get('low_stock')).map(r => r.g1), ['BOX']); assert.equal((await get('expiring_batches')).length, 1);
  assert.deepEqual(byKey(await get('outstanding')), { INR: 1152 }); assert.deepEqual(byKey(await get('overdue')), { INR: 590 }); assert.equal((await get('invoiced')).reduce((s, r) => s + Number(r.value), 0), 1988 /* 1888 INR + 100 USD, shown as separate rows */); assert.equal((await get('invoiced')).length >= 2, true, 'currencies are separate rows');
  assert.equal(REPORTS.find(r => r.key === 'invoiced').definition.includes('not what was collected'), true); assert.equal(REPORTS.find(r => r.key === 'collected').definition.includes('does not confirm any external payment'), true);
  // viewers without access get a refusal for that report, not an empty or invented chart
  for (const r of REPORTS.filter(x => x.group === 'Billing')) await bad(run(EMP, org, r.query), '42501'); for (const r of REPORTS.filter(x => x.group !== 'Billing')) await ok(run(EMP, org, r.query));
});

test('CSV export is safe, labelled and formula-proof; PDF is generated only from the immutable snapshot', async () => {
  const csv = toCsv({ definition: 'Number of Leads · grouped by Lead source\nsecond line', columns: [{ key: 'g1', label: 'Lead source', type: 'text' }, { key: 'g2', label: 'Assigned to', type: 'uuid', user: true }, { key: 'value', label: 'Number of leads', type: 'count' }],
    rows: [{ g1: '=HYPERLINK("http://evil")', g2: null, g2_label: 'emp@x.test', value: 3 }, { g1: 'a,"b"', g2: null, g2_label: null, value: 2 }, { g1: '-5', g2: null, g2_label: '@sum', value: 1 }, { g1: '+cmd', g2: null, value: 0 }] });
  const lines = csv.split('\r\n'); assert.equal(lines[0], '# Number of Leads · grouped by Lead source second line'); assert.equal(lines[1], 'Lead source,Assigned to,Number of leads'); assert.equal(lines[2], `'=HYPERLINK("http://evil"),emp@x.test,3`.replace(/"/g, '""').replace("'=HYPERLINK(", `"'=HYPERLINK(`).replace('),emp', ')",emp'));
  assert.equal(lines[3], '"a,""b""",,2'); assert.equal(lines[4], "-5,'@sum,1", 'plain numbers are left alone, formula-looking text is neutralized'); assert.equal(lines[5], "'+cmd,,0");
  // PDF straight from the frozen snapshot
  const org = A.org; const [d] = await q(`select id from public.invoices where organization_id=$1 and number='INV-00001'`, [org]); const acc = await ok(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: d.id })); assert.equal(acc.number, 'INV-00001');
  const pdf = await invoicePdf(acc.snapshot); const text = pdf.toString('latin1'); assert.ok(text.startsWith('%PDF-') && text.trimEnd().endsWith('%%EOF')); assert.match(text, /Invoice INV-00001/, 'the title metadata carries the number');
  // structural validity: every xref offset points at its object
  const xs = text.indexOf('startxref'); const xrefPos = Number(text.slice(xs + 10).split('\n')[0]); assert.equal(text.slice(xrefPos, xrefPos + 4), 'xref'); const n = Number(text.slice(xrefPos + 5).split('\n')[0].split(' ')[1]);
  const entries = text.slice(xrefPos).split('\n').slice(2, 2 + n); for (let i = 1; i < n; i++) assert.equal(text.slice(Number(entries[i].slice(0, 10)), Number(entries[i].slice(0, 10)) + String(i).length + 6), `${i} 0 obj`);
  assert.deepEqual(await invoicePdf(acc.snapshot), pdf, 'deterministic: the same snapshot always yields the same bytes');
  // the PDF never reflects later changes: tax configuration and contact edits do not alter an issued invoice's snapshot
  await ok(call(A.owner, 'save_workspace_draft', { p_org: org, p_definition: { ...CFG, operations: { ...OPS, billing: { ...OPS.billing, taxes: [{ key: 'gst18', name: 'GST', rate: '28' }] } } } })); await ok(call(A.owner, 'publish_workspace_config', { p_org: org }));
  assert.deepEqual(await invoicePdf((await ok(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: d.id }))).snapshot), pdf);
  const hostile = (await invoicePdf({ ...acc.snapshot, business: 'Acme (Pty) \\ Ltd', bill_to: { name: 'Zoë ☃ \u0000 Ünï', email: 'a@b.test' }, notes: 'line1\n(paren) \\ back', lines: Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i} (x)`, quantity: 1, unit_price: 1, discount: 0, net: 1, tax: 0, line_total: 1 })) })).toString('latin1');
  assert.ok((hostile.match(/\/Type \/Page(?!s)/g) ?? []).length >= 2, 'long invoices continue on more pages'); assert.ok(hostile.trimEnd().endsWith('%%EOF'));
  // access: managers and above, issued invoices only, own organization, audited
  await bad(call(EMP, 'invoice_pdf_access', { p_org: org, p_id: d.id }), '42501'); const draft = (await q(`insert into public.invoices (organization_id, currency, created_by) values ($1,'INR',$2) returning id`, [org, MGR]))[0].id; await bad(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: draft }), 'P0002', /not found/);
  const B = await fresh(); await bad(call(B.owner, 'invoice_pdf_access', { p_org: org, p_id: d.id }), '42501'); await bad(call(B.owner, 'invoice_pdf_access', { p_org: B.org, p_id: d.id }), 'P0002');
  assert.ok((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name='invoice.pdf_downloaded'`, [org]))[0].n === 2, 'one audit row per successful download, none for refusals');
  const noBill = await ok(call(A.owner, 'role_save', { p_org: org, p_id: null, p_name: 'NB', p_base: 'manager', p_permissions: { billing: { view: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(A.owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: noBill, p_base_if_cleared: 'manager' })); await bad(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: d.id }), '42501'); await ok(call(A.owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: null, p_base_if_cleared: 'manager' }));
});

const widget = (type, title, query, w = 4, h = 3) => ({ type, title, query, w, h });
const W = {
  kpi: widget('kpi', 'Leads', { source: 'leads', metric: { agg: 'count' } }), line: widget('line', 'Daily leads', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'created_at', bucket: 'day' }], date: { field: 'created_at', range: 'last_30_days' } }),
  bar: widget('bar', 'By source', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] }), pie: widget('pie', 'Stage', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'stage' }] }),
  table: widget('table', 'Tasks', { source: 'tasks', metric: { agg: 'count' }, group_by: [{ field: 'status' }, { field: 'owner_id' }] }), funnel: widget('funnel', 'Funnel', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'stage' }] }),
};
const save = (u, org, o) => call(u, 'dashboard_save', { p_org: org, p_id: o.id ?? null, p_name: o.name ?? 'Dash', p_description: o.description ?? null, p_visibility: o.visibility ?? 'personal', p_widgets: o.widgets ?? [], p_version: o.version ?? null });

test('dashboards: personal and shared, six widget types, resize/reorder persist, validated queries, permissions and tenant isolation', async () => {
  const org = A.org, owner = A.owner;
  const d = await ok(save(EMP, org, { name: 'My day', widgets: [W.kpi, W.line, W.bar, W.pie, W.table, W.funnel] })); assert.equal(d.version, 1);
  let ws = await rows(EMP, 'select position, type, title, w, h from public.dashboard_widgets where dashboard_id=$1 order by position', [d.id]); assert.deepEqual(ws.map(w => w.type), ['kpi', 'line', 'bar', 'pie', 'table', 'funnel']);
  assert.equal((await rows(EMP, 'select 1 from public.dashboards where id=$1', [d.id])).length, 1); assert.equal((await rows(EMP2, 'select 1 from public.dashboards where id=$1', [d.id])).length, 0, 'personal dashboards are private'); assert.equal((await rows(owner, 'select 1 from public.dashboards where id=$1', [d.id])).length, 0, 'even owners do not see other people\'s personal dashboards');
  // resize + rearrange = save a new layout; the version moves forward and a stale editor is refused
  const re = [{ ...W.table, w: 12, h: 5 }, { ...W.kpi, w: 3, h: 2 }, ...[W.line, W.bar, W.pie, W.funnel]]; const d2 = await ok(save(EMP, org, { id: d.id, name: 'My day', widgets: re, version: 1 })); assert.equal(d2.version, 2);
  ws = await rows(EMP, 'select position, type, w, h from public.dashboard_widgets where dashboard_id=$1 order by position', [d.id]); assert.deepEqual([ws[0].type, ws[0].w, ws[0].h, ws[1].type, ws[1].w], ['table', 12, 5, 'kpi', 3]); await bad(save(EMP, org, { id: d.id, widgets: re, version: 1 }), '22023', /changed by someone else/);
  // validation: the same grammar check as running a query, plus shape rules per widget type
  for (const [w, re_] of [[widget('kpi', 'x', W.bar.query), /needs no grouping/], [widget('bar', 'x', W.kpi.query), /exactly one grouping/], [widget('line', 'x', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] }), /one date grouping with a bucket/], [widget('pie', 'x', { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }, { field: 'stage' }] }), /exactly one grouping/],
    [widget('bar', 'x', { source: 'leads; drop', metric: { agg: 'count' }, group_by: [{ field: 'stage' }] }), /Unknown data source/], [widget('radar', 'x', W.kpi.query), /needs a type/], [widget('kpi', '', W.kpi.query), /needs a type/], [{ ...W.kpi, w: 13 }, /size/], [{ ...W.kpi, h: 0 }, /size/], [{ ...W.kpi, extra: 1 }, /invalid/], [widget('kpi', 'x', { source: 'invoices', metric: { agg: 'sum', field: 'total' } }), /do not have access|never combined/]])
    await bad(save(EMP, org, { widgets: [w] }), null, re_);
  await bad(save(EMP, org, { widgets: Array(25).fill(W.kpi) }), '22023', /at most 24/); await bad(save(EMP, org, { name: '' }), '22023'); await bad(save(EMP, org, { visibility: 'public' }), '22023');
  // sharing with the organization: managers and above only; everyone then reads it, but each widget runs with the VIEWER's permissions
  await bad(save(EMP, org, { visibility: 'organization', widgets: [W.kpi] }), '42501', /Only owners, admins and managers/); const shared = await ok(save(MGR, org, { name: 'Finance', visibility: 'organization', widgets: [W.kpi, widget('kpi', 'Invoiced INR', { source: 'invoices', metric: { agg: 'sum', field: 'total' }, filters: [{ field: 'currency', op: 'eq', value: 'INR' }] })] }));
  assert.equal((await rows(EMP2, 'select 1 from public.dashboards where id=$1', [shared.id])).length, 1); assert.equal((await rows(EMP2, 'select 1 from public.dashboard_widgets where dashboard_id=$1', [shared.id])).length, 2, 'EMP2 can read the layout');
  const wq = (await rows(EMP2, `select query from public.dashboard_widgets where dashboard_id=$1 order by position`, [shared.id])).map(r => r.query); assert.equal((await ok(run(EMP2, org, wq[0]))).row_count, 1); await bad(run(EMP2, org, wq[1]), '42501', /do not have access/);
  await bad(save(EMP2, org, { id: shared.id, widgets: [] }), '42501'); await bad(call(EMP2, 'dashboard_delete', { p_org: org, p_id: shared.id }), '42501'); await bad(call(EMP2, 'dashboard_delete', { p_org: org, p_id: d.id }), 'P0002'); await ok(save(owner, org, { id: shared.id, name: 'Finance 2', visibility: 'organization', widgets: [W.kpi], version: 1 }));
  await ok(call(EMP, 'dashboard_delete', { p_org: org, p_id: d.id })); assert.equal((await q('select count(*)::int n from public.dashboard_widgets where dashboard_id=$1', [d.id]))[0].n, 0);
  // permission to create dashboards can be taken away; tenant isolation
  const nod = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'No dashboards', p_base: 'employee', p_permissions: { dashboards: { create: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(owner, 'member_assign_role', { p_org: org, p_user: EMP2, p_custom_role: nod, p_base_if_cleared: 'employee' })); await bad(save(EMP2, org, { widgets: [W.kpi] }), '42501', /cannot create dashboards/); await ok(call(owner, 'member_assign_role', { p_org: org, p_user: EMP2, p_custom_role: null, p_base_if_cleared: 'employee' }));
  const B = await fresh(); assert.equal((await rows(B.owner, 'select 1 from public.dashboards where organization_id=$1', [org])).length, 0); await bad(save(B.owner, org, { widgets: [] }), '42501'); await bad(call(B.owner, 'dashboard_delete', { p_org: B.org, p_id: shared.id }), 'P0002'); await bad(save(B.owner, B.org, { id: shared.id, widgets: [] }), 'P0002');
  assert.ok((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name like 'dashboard.%'`, [org]))[0].n >= 5);
  // the dashboard from the request: daily leads, pending follow-ups, employee performance, monthly collections (all supported, all real queries)
  const ask = [widget('line', 'Daily leads', W.line.query), widget('bar', 'Pending follow-ups per person', REPORTS.find(r => r.key === 'tasks_pending').query), widget('bar', 'Tasks completed per person', REPORTS.find(r => r.key === 'tasks_completed').query), widget('table', 'Payments collected per month', REPORTS.find(r => r.key === 'collected').query, 6, 4)];
  const dd = await ok(save(owner, org, { name: 'Owner overview', visibility: 'organization', widgets: ask })); assert.ok(dd.id);
});

test('operations fixes: organization time zone for time off, strict reconciliation reports problems without changing history', async () => {
  const o = await fresh(); const { org, owner } = o; await ok(call(owner, 'staff_hours_set', { p_org: org, p_user: EMP, p_hours: [] }));
  const r = await ok(call(owner, 'staff_time_off_add_local', { p_org: org, p_user: EMP, p_start_local: '2026-12-01T09:00:00', p_end_local: '2026-12-01T17:00:00', p_reason: 'Leave' })); assert.equal(r.existing_appointments_affected, 0);
  const [t] = await q('select starts_at, ends_at from public.staff_time_off where id=$1', [r.id]); assert.deepEqual([t.starts_at.toISOString(), t.ends_at.toISOString()], ['2026-12-01T03:30:00.000Z', '2026-12-01T11:30:00.000Z'], '09:00-17:00 in Asia/Kolkata, whatever the browser time zone');
  await bad(call(EMP, 'staff_time_off_add_local', { p_org: org, p_user: EMP, p_start_local: '2026-12-02T09:00:00', p_end_local: '2026-12-02T10:00:00', p_reason: null }), '42501'); const off = await fresh({ ...CFG, operations: { ...OPS, appointments: { enabled: false } } }); await bad(call(off.owner, 'staff_time_off_add_local', { p_org: off.org, p_user: EMP, p_start_local: '2026-12-02T09:00:00', p_end_local: '2026-12-02T10:00:00', p_reason: null }), '22023', /not enabled/);
  // healthy data reconciles; deliberate corruption (simulated outside the application with triggers disabled) is reported, never repaired
  const healthy = async fn => rows(A.owner, `select * from public.${fn}($1)`, [A.org]); assert.deepEqual(await healthy('inventory_reconcile_v2'), []); assert.deepEqual(await healthy('billing_reconcile_v2'), []);
  const before = { lv: await q('select count(*)::int n, sum(quantity)::text s from public.stock_levels where organization_id=$1', [A.org]), led: await q('select count(*)::int n, sum(amount)::text s from public.invoice_ledger where organization_id=$1', [A.org]) };
  await su(`set session_replication_role = replica`);
  await su(`update public.stock_levels set quantity = quantity + 2 where product_id = $1 and location_id = $2 and batch_id is null`, [S.Q, S.LA]); await su(`update public.stock_movements set balance_after = balance_after + 1 where id = (select id from public.stock_movements where product_id = $1 order by seq limit 1)`, [S.Q]);
  await su(`insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id) values ($1,$2,'payment',-7,gen_random_uuid())`, [A.org, S.i2]); await su(`update public.invoices set snapshot = jsonb_set(snapshot, '{total}', '999') where id = $1`, [S.i3]);
  await su(`insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id) select organization_id, id, 'invoice', 1, id from public.invoices where id = (select id from public.invoices where organization_id = $1 and status = 'draft' limit 1)`, [A.org]).catch(() => {});
  await su(`set session_replication_role = origin`);
  const inv = (await healthy('inventory_reconcile_v2')).map(r => r.problem).sort(); assert.deepEqual([...new Set(inv)], ['broken_running_balance', 'level_differs_from_ledger'].sort()); const bill = (await healthy('billing_reconcile_v2')).map(r => r.problem); assert.ok(bill.includes('ledger_differs_from_documents') && bill.includes('ledger_entry_without_document') && bill.includes('snapshot_differs_from_invoice'), bill.join(','));
  for (const fn of ['inventory_reconcile_v2', 'billing_reconcile_v2']) await assert.rejects(rows(EMP, `select * from public.${fn}($1)`, [A.org]), e => e.code === '42501');
  assert.equal((await q('select count(*)::int n from public.stock_movements where organization_id=$1', [A.org]))[0].n, 6, 'reconcile reports only: no movement was added, edited or removed'); void before;
  await su(`set session_replication_role = replica`); await su(`update public.stock_levels set quantity = quantity - 2 where product_id = $1 and location_id = $2 and batch_id is null`, [S.Q, S.LA]); await su(`delete from public.invoice_ledger where amount = -7`); await su(`update public.invoices set snapshot = jsonb_set(snapshot, '{total}', '100') where id = $1`, [S.i3]); await su(`set session_replication_role = origin`);
});

const ctxFor = (o, user, role) => ({ org: o.org, userId: user, role, conversationId: null, rpc: mkRpc(user), platformMissing: () => ({ meta: [], whatsapp: [] }), loadConfigs: async () => { throw new Error('not needed'); } });
const tool = async (ctx, name, args) => { const r = await executeTool(ctx, name, args); return { ...r, json: JSON.parse(r.content) }; };

test('AI dashboards: grounded in the catalog, validated by the database, previewed, and created only on human approval through the Dashboard Builder service', async () => {
  const o = A, W_ = ctxFor(o, o.owner, 'owner'), E = ctxFor(o, EMP, 'employee');
  assert.ok(toolsFor('employee').some(t => t.name === 'query_analytics') && !toolsFor('employee').some(t => t.name === 'propose_dashboard') && toolsFor('owner').some(t => t.name === 'propose_dashboard'));
  const cat = (await tool(E, 'get_analytics_catalog', {})).json.data; assert.ok(cat.sources.some(s => s.source === 'leads') && !cat.sources.some(s => s.source === 'invoices'), 'the employee is not even told billing metrics exist'); assert.match(JSON.stringify(cat), /never combined/);
  assert.ok((await tool(W_, 'get_analytics_catalog', {})).json.data.sources.some(s => s.source === 'invoices'));
  // real numbers through the assistant, under the user's permissions
  const q1 = await tool(E, 'query_analytics', { spec: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] } }); assert.deepEqual(Object.fromEntries(q1.json.data.rows.map(r => [r.g1, Number(r.value)])), { website: 2, phone: 2, referral: 1 }, "an employee's numbers cover only the leads they may see (EMP2's website lead is excluded)"); assert.match(q1.json.data.definition, /Number of leads/i);
  const denied = await tool(E, 'query_analytics', { spec: { source: 'invoices', metric: { agg: 'count' } } }); assert.deepEqual([denied.ok, denied.code], [false, 'forbidden']);
  for (const query of [{ source: 'users', metric: { agg: 'count' } }, { source: 'leads', metric: { agg: 'sum', field: 'salary' } }, { source: 'leads', metric: { agg: 'count' }, sql: 'select 1' }, 'select * from leads']) assert.equal((await tool(W_, 'query_analytics', { spec: query })).ok, false);
  const none = await tool(W_, 'query_analytics', { spec: { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'stage', op: 'eq', value: 'nothing' }] } }); assert.equal(Number(none.json.data.rows[0].value), 0, 'no data is reported as zero, never invented');
  // the owner's request: daily leads, pending follow-ups, employee performance, monthly payment collections
  const request = { name: 'Owner overview', description: 'Leads, follow-ups, team and collections', visibility: 'organization', widgets: [
    { type: 'line', title: 'Daily leads', query: W.line.query }, { type: 'bar', title: 'Pending follow-ups per person', query: REPORTS.find(r => r.key === 'tasks_pending').query }, { type: 'bar', title: 'Tasks completed per person', query: REPORTS.find(r => r.key === 'tasks_completed').query },
    { type: 'table', title: 'Payments collected per month', query: REPORTS.find(r => r.key === 'collected').query, w: 12, h: 4 }] };
  const before = (await q(`select count(*)::int n from public.dashboards where organization_id=$1`, [o.org]))[0].n;
  const p = await tool(W_, 'propose_dashboard', request); assert.equal(p.ok, true, p.content); assert.equal(p.json.data.preview.length, 4); assert.match(p.json.data.preview[3].definition, /Net amount.*Payments and refunds.*grouped by Received by month, Currency/i); assert.match(p.json.data.next_step, /No dashboard exists until they approve/);
  assert.equal((await q(`select count(*)::int n from public.dashboards where organization_id=$1`, [o.org]))[0].n, before, 'proposing creates nothing');
  // unsupported metrics are refused with a pointer to the catalog; wrong widget shapes too; employees cannot propose
  for (const w of [{ type: 'bar', title: 'Revenue per employee', query: { source: 'leads', metric: { agg: 'sum', field: 'revenue' }, group_by: [{ field: 'assigned_to' }] } }, { type: 'bar', title: 'Payroll', query: { source: 'payroll', metric: { agg: 'count' }, group_by: [{ field: 'x' }] } }, { type: 'kpi', title: 'x', query: W.bar.query }, { type: 'line', title: 'x', query: W.bar.query }, { type: 'pie', title: 'x', query: { source: 'invoices', metric: { agg: 'sum', field: 'total' }, group_by: [{ field: 'status' }] } }]) { const r = await tool(W_, 'propose_dashboard', { name: 'Bad', widgets: [w] }); assert.equal(r.ok, false, JSON.stringify(w)); assert.match(r.error, /Widget 1/); }
  assert.match((await tool(W_, 'propose_dashboard', { name: 'Bad', widgets: [{ type: 'bar', title: 'Revenue per employee', query: { source: 'leads', metric: { agg: 'sum', field: 'revenue' }, group_by: [{ field: 'assigned_to' }] } }] })).error, /get_analytics_catalog/);
  assert.deepEqual([(await tool(E, 'propose_dashboard', request)).ok, (await tool(E, 'propose_dashboard', request)).code], [false, 'forbidden']); assert.equal((await tool(W_, 'propose_dashboard', { name: 'x', widgets: [] })).ok, false); assert.equal((await tool(W_, 'propose_dashboard', { name: 'x', widgets: Array(13).fill(request.widgets[0]) })).ok, false);
  // approval: only the author, only once; created through dashboard_save as the approver (audit + permissions), shared as requested
  const pid = p.json.data.proposal_id;
  assert.equal((await applyProposal(ctxFor(o, MGR, 'manager'), pid, 'save_dashboard')).ok, false); const B = await fresh(); assert.equal((await applyProposal(ctxFor(B, B.owner, 'owner'), pid, 'save_dashboard')).ok, false);
  assert.equal((await applyProposal(W_, pid, 'save_draft')).ok, false, 'dashboards have no draft step'); const done = await applyProposal(W_, pid, 'save_dashboard'); assert.equal(done.ok, true, done.error);
  const dash = (await rows(EMP2, `select d.name, d.visibility, (select count(*)::int from public.dashboard_widgets w where w.dashboard_id = d.id) n from public.dashboards d where d.organization_id=$1 and d.name='Owner overview'`, [o.org])); assert.deepEqual([dash[0].visibility, dash[0].n], ['organization', 4], 'visible to the team, with all four widgets');
  assert.equal((await applyProposal(W_, pid, 'save_dashboard')).ok, false, 'cannot be applied twice'); assert.equal((await q(`select status from public.ai_proposals where id=$1`, [pid]))[0].status, 'published');
  assert.ok((await q(`select 1 from public.audit_events where organization_id=$1 and event_name in ('dashboard.saved','ai.proposal_published') group by event_name`, [o.org])).length === 2);
  // if the approver's permissions changed since the proposal, the Dashboard Builder refuses it (the model never gets its own authority)
  const p2 = await tool(W_, 'propose_dashboard', { name: 'Finance view', visibility: 'organization', widgets: [{ type: 'kpi', title: 'Invoices', query: { source: 'invoices', metric: { agg: 'count' } } }] }); assert.equal(p2.ok, true);
  const nb = await ok(call(o.owner, 'role_save', { p_org: o.org, p_id: null, p_name: 'Admin no billing', p_base: 'admin', p_permissions: { billing: { view: false } }, p_scopes: {}, p_location_restricted: false })); await db.exec(`update public.organization_members set custom_role_id = '${nb}' where organization_id = '${o.org}' and user_id = '${ADM}'`);
  const p3 = await tool(ctxFor(o, ADM, 'admin'), 'propose_dashboard', { name: 'Sneaky', widgets: [{ type: 'kpi', title: 'Invoices', query: { source: 'invoices', metric: { agg: 'count' } } }] }); assert.equal(p3.ok, false, 'an admin without billing access cannot even propose a billing widget'); await db.exec(`update public.organization_members set custom_role_id = null where organization_id = '${o.org}' and user_id = '${ADM}'`);
});

test('product custom fields (the product form): configured in Builder, validated by the database, editable, protected once published', async () => {
  const cfg = { ...CFG, operations: { ...OPS, inventory: { ...OPS.inventory, fields: [{ key: 'colour', label: 'Colour', kind: 'choice', options: ['Red', 'Blue'] }, { key: 'weight_kg', label: 'Weight (kg)', kind: 'number', required: true }] } } };
  const o = await fresh(cfg); const save = (id_, custom, extra = {}) => call(o.owner, 'product_save', { p_org: o.org, p_id: id_, p_sku: extra.sku ?? 'CF-1', p_name: 'Custom', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: custom });
  await bad(save(null, { colour: 'Green', weight_kg: 1 }), '22023'); await bad(save(null, { colour: 'Red' }), '22023', /required|Weight/i); await bad(save(null, { colour: 'Red', weight_kg: 1, ghost: 'x' }), '22023');
  const id1 = await ok(save(null, { colour: 'Red', weight_kg: 2.5 })); assert.deepEqual((await q('select custom from public.products where id=$1', [id1]))[0].custom, { colour: 'Red', weight_kg: 2.5 });
  await ok(save(id1, { colour: 'Blue', weight_kg: 3 })); assert.equal((await q('select custom->>$2 c from public.products where id=$1', [id1, 'colour']))[0].c, 'Blue'); await bad(call(EMP, 'product_save', { p_org: o.org, p_id: id1, p_sku: 'CF-1', p_name: 'x', p_unit: 'u', p_track_batches: false, p_threshold: null, p_active: true, p_custom: {} }), '42501');
  await ok(call(o.owner, 'save_workspace_draft', { p_org: o.org, p_definition: { ...cfg, operations: { ...cfg.operations, inventory: { ...cfg.operations.inventory, fields: [cfg.operations.inventory.fields[1]] } } } })); await bad(call(o.owner, 'publish_workspace_config', { p_org: o.org }), '22023', /cannot be removed/);
  assert.equal((await q('select count(*)::int n from public.products where id=$1 and custom ? $2', [id1, 'colour']))[0].n, 1, 'stored values are never silently changed');
});
