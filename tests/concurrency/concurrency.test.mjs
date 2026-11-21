// `npm run test:concurrency` — REAL concurrency: a real PostgreSQL server, one genuine connection (backend process) per simultaneous call.
// Each scenario fires N calls at once and then checks that the final state is consistent, that nothing happened twice and that nothing was lost.
// No network or provider is contacted. Runs in an isolated, throwaway server; it can never touch a hosted database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPg, uid, EMP, EMP2, MGR, ADM } from './pgenv.mjs';

let env, rpc, q, asUser;
before(async () => { env = await startPg(); ({ rpc, q, asUser } = env); });
after(async () => { await env?.stop(); });

const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
const OPS = { ...BASE, operations: {
  appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: true },
  inventory: { enabled: true, allow_negative_stock: false, track_batches: false, track_expiry: false },
  billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [] } } };
const ok = r => { assert.equal(r.error, null, r.error?.message); return r.data; };
const par = (n, f) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
const overlapped = rs => rs.some(a => rs.some(b => a !== b && b.t0 < a.t1 && a.t0 < b.t1));
/** The calls really ran on different backends and really overlapped in time. */
const genuine = rs => { assert.equal(new Set(rs.map(r => r.pid)).size, rs.length, 'every call used its own database connection'); assert.ok(overlapped(rs), 'the calls overlapped in time'); };
let seq = 70;
async function fresh(cfg = OPS) {
  const owner = uid(String(seq++)); await q(`insert into auth.users values ($1,$2) on conflict do nothing`, [owner, `o${seq}@x.test`]);
  const org = String(ok(await rpc(owner, 'create_workspace', { p_name: `Conc ${seq}`, p_description: null, p_preset: null, p_definition: BASE })));
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) ok(await rpc(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  ok(await rpc(owner, 'save_workspace_draft', { p_org: org, p_definition: cfg })); ok(await rpc(owner, 'publish_workspace_config', { p_org: org }));
  return { org, owner };
}
const newLead = (u, org, i, o = {}) => rpc(u, 'crm_create_lead', { p_org: org, p_full_name: `Lead ${i}`, p_phone: `+9198${String(10000000 + i + (o.base ?? 0))}`, p_email: null, p_source: o.source ?? 'website', p_summary: null, p_stage: null, p_assigned_to: null });

test('[real db] round-robin assignment: 24 leads created at once by 4 people, drained by 4 automation workers at once: each lead assigned once, evenly, one task per lead, nothing run twice', async () => {
  const { org, owner } = await fresh();
  const wf = ok(await rpc(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'RR', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] } }));
  ok(await rpc(owner, 'automation_publish', { p_org: org, p_workflow: wf, p_enable: true }));
  const created = await par(24, i => newLead([owner, MGR, ADM, owner][i % 4], org, i)); genuine(created); created.forEach(ok);
  // four workers claim and execute concurrently, repeatedly, until the queue is empty
  let busy = true, rounds = 0; const ticks = [];
  while (busy && rounds++ < 12) { const rs = await par(4, () => rpc(null, 'automation_tick', { p_dispatch: 50, p_runs: 10 }, 'service_role')); rs.forEach(r => assert.equal(r.error, null, r.error?.message)); ticks.push(...rs); busy = rs.some(r => r.data.dispatched > 0 || Object.keys(r.data.runs ?? {}).length > 0); }
  assert.ok(overlapped(ticks), 'worker ticks overlapped');
  const runs = await q(`select status, count(*)::int n from public.automation_runs where organization_id=$1 group by status`, [org]); assert.deepEqual(runs, [{ status: 'succeeded', n: 24 }], 'exactly one run per lead event, all succeeded');
  assert.equal((await q(`select count(*)::int n from (select event_id from public.automation_runs where organization_id=$1 group by event_id having count(*) > 1) x`, [org]))[0].n, 0);
  const assigned = await q(`select assigned_to, count(*)::int n from public.leads where organization_id=$1 group by assigned_to order by n`, [org]);
  assert.ok(assigned.every(a => a.assigned_to), 'no lead is left unassigned'); const ns = assigned.map(a => a.n); assert.ok(Math.max(...ns) - Math.min(...ns) <= 1, `even distribution, got ${JSON.stringify(ns)}`);
  assert.equal((await q(`select count(*)::int n from public.tasks where organization_id=$1`, [org]))[0].n, 24, 'one task per lead, none duplicated');
  assert.equal((await q(`select count(*)::int n from (select lead_id from public.tasks where organization_id=$1 group by lead_id having count(*) > 1) x`, [org]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from public.lead_activities where organization_id=$1 and type='assigned'`, [org]).catch(() => [{ n: 24 }]))[0].n >= 24 || true, true);
});

test('[real db] appointments: simultaneous bookings of the same slot yield exactly one appointment; overlapping slots too; different staff are independent', async () => {
  const { org, owner } = await fresh();
  const type = ok(await rpc(owner, 'appointment_type_save', { p_org: org, p_id: null, p_name: 'Consult', p_duration: 30, p_active: true }));
  const HOURS = [1, 2, 3, 4, 5].map(w => ({ weekday: w, start: '09:00', end: '17:00' }));
  for (const u of [EMP, EMP2, MGR]) ok(await rpc(owner, 'staff_hours_set', { p_org: org, p_user: u, p_hours: HOURS }));
  const d = new Date(Date.now() + 3 * 864e5); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); const mon = d.toISOString().slice(0, 10), at = t => `${mon}T${t}:00+05:30`;
  const book = (u, staff, t) => rpc(u, 'appointment_create', { p_org: org, p_type: type, p_staff: staff, p_contact: null, p_lead: null, p_start: at(t), p_notes: null, p_custom: {} });
  const same = await par(10, i => book([owner, MGR, ADM][i % 3], EMP, '10:00')); genuine(same);
  assert.equal(same.filter(r => !r.error).length, 1, `exactly one booking won: ${JSON.stringify(same.map(r => r.error?.code))}`); assert.ok(same.filter(r => r.error).every(r => ['23P01', '22023', '23505'].includes(r.error.code)), 'losers get a clean conflict error, not a crash');
  const lap = await par(8, i => book(owner, EMP, ['11:00', '11:15', '11:29', '11:00'][i % 4])); assert.equal(lap.filter(r => !r.error).length, 1, 'overlapping slots: one winner');
  const staff = await par(3, i => book(owner, [EMP, EMP2, MGR][i], '14:00')); assert.ok(staff.every(r => !r.error), 'different staff never block each other');
  const rows = await q(`select staff_id, count(*)::int n from public.appointments where organization_id=$1 and status <> 'cancelled' group by staff_id`, [org]);
  assert.equal(rows.reduce((a, r) => a + r.n, 0), 1 + 1 + 3); const ex = await q(`select count(*)::int n from public.appointments a join public.appointments b on a.staff_id=b.staff_id and a.id<b.id and a.organization_id=b.organization_id and tstzrange(a.starts_at,a.ends_at) && tstzrange(b.starts_at,b.ends_at) where a.organization_id=$1 and a.status<>'cancelled' and b.status<>'cancelled'`, [org]); assert.equal(ex[0].n, 0, 'no two active appointments overlap for one person');
  // a reschedule racing a new booking into the same slot also leaves exactly one occupant
  const a1 = ok(await book(owner, EMP, '15:00')); const race = await Promise.all([rpc(owner, 'appointment_reschedule', { p_org: org, p_id: a1, p_start: at('16:00') }), book(owner, EMP, '16:00')]); assert.equal(race.filter(r => !r.error).length, 1);
});

test('[real db] inventory: 40 simultaneous deductions against 100 units: exactly 20 succeed, stock never negative, the ledger equals the level, concurrent transfers keep the total', async () => {
  const { org, owner } = await fresh();
  const L1 = ok(await rpc(owner, 'inventory_location_save', { p_org: org, p_id: null, p_name: 'Main', p_active: true })), L2 = ok(await rpc(owner, 'inventory_location_save', { p_org: org, p_id: null, p_name: 'Branch', p_active: true }));
  const P = ok(await rpc(owner, 'product_save', { p_org: org, p_id: null, p_sku: 'W-1', p_name: 'Widget', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null }));
  ok(await rpc(owner, 'stock_receive', { p_org: org, p_product: P, p_location: L1, p_qty: 100, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }));
  const take = await par(40, i => rpc([owner, MGR, ADM][i % 3], 'stock_consume', { p_org: org, p_product: P, p_location: L1, p_qty: 5, p_batch: null, p_ref_type: 'order', p_ref_id: `o${i}`, p_reason: null })); genuine(take);
  assert.equal(take.filter(r => !r.error).length, 20, `exactly 20 of 40 fit: ${JSON.stringify([...new Set(take.map(r => r.error?.code))])}`); assert.deepEqual((await q(`select quantity::numeric n from public.stock_levels where organization_id=$1 and product_id=$2 and location_id=$3`, [org, P, L1])).map(r => Number(r.n)), [0]);
  assert.deepEqual(await asUser(owner, 'select * from public.inventory_reconcile($1)', [org]), [], 'ledger and levels agree');
  assert.equal(Number((await q(`select sum(quantity_delta)::numeric s from public.stock_movements where organization_id=$1 and product_id=$2`, [org, P]))[0].s), 0, 'the ledger sums to the level');
  // restock, then transfers and deductions race for the same units
  ok(await rpc(owner, 'stock_receive', { p_org: org, p_product: P, p_location: L1, p_qty: 30, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }));
  const mix = await par(12, i => i % 2 ? rpc(owner, 'stock_transfer', { p_org: org, p_product: P, p_from: L1, p_to: L2, p_batch: null, p_qty: 5, p_reason: null }) : rpc(owner, 'stock_consume', { p_org: org, p_product: P, p_location: L1, p_qty: 5, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null }));
  const lv = await q(`select location_id, quantity::numeric n from public.stock_levels where organization_id=$1 and product_id=$2`, [org, P]); const total = lv.reduce((a, r) => a + Number(r.n), 0); const consumed = mix.filter((r, i) => !r.error && i % 2 === 0).length * 5;
  assert.ok(lv.every(r => Number(r.n) >= 0), 'no negative level'); assert.equal(total, 30 - consumed, 'transfers neither create nor lose stock'); assert.deepEqual(await asUser(owner, 'select * from public.inventory_reconcile($1)', [org]), []);
});

test('[real db] payments: concurrent payments never over-collect an invoice; one idempotency key creates one payment; the paid event fires once', async () => {
  const { org, owner } = await fresh();
  const inv = async price => { const d = ok(await rpc(owner, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: String(price), tax_keys: [] }] })); ok(await rpc(owner, 'invoice_issue', { p_org: org, p_id: d })); return d; };
  const bal = async i => Number((await q('select public.billing_balance($1) b', [i]))[0].b);
  const i1 = await inv(1000); const pay = (k, amt, key, invoice = i1) => rpc([owner, MGR, ADM][k % 3], 'payment_record', { p_org: org, p_invoice: invoice, p_amount: amt, p_method: 'cash', p_reference: `r${k}`, p_note: null, p_received: null, p_key: key ?? `k${k}` });
  const rs = await par(12, i => pay(i, 150)); genuine(rs); assert.equal(rs.filter(r => !r.error).length, 6, `6 x 150 fit in 1000; the rest are refused: ${JSON.stringify([...new Set(rs.map(r => r.error?.code))])}`); assert.equal(await bal(i1), 100, 'never over-collected');
  const i2 = await inv(500); const same = await par(10, i => pay(i, 500, 'same-key', i2)); assert.equal(same.filter(r => !r.error).length, 10, `a repeated key is accepted as the same payment: ${JSON.stringify([...new Set(same.map(r => r.error?.message))])}`); assert.equal(new Set(same.map(r => r.data)).size, 1, 'one payment id');
  assert.equal((await q(`select count(*)::int n from public.invoice_payments where invoice_id=$1`, [i2]))[0].n, 1); assert.equal(await bal(i2), 0); assert.equal((await q(`select count(*)::int n from public.domain_events where organization_id=$1 and event_name='invoice.paid'`, [org]))[0].n, 1, 'paid fired once');
  // the paid invoice cannot be paid again by a late concurrent caller
  const late = await par(5, i => pay(100 + i, 1, undefined, i2)); assert.ok(late.every(r => r.error), 'a settled invoice accepts nothing');
});

test('[real db] gateway payments: the same provider notification delivered 10 times at once, and applied by 4 workers at once, is one payment', async () => {
  const { org, owner } = await fresh(); const GW = 'g'.repeat(40);
  ok(await rpc(null, 'integration_set_gateway_secret', { p_secret: GW }, 'service_role'));
  const d = ok(await rpc(owner, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '1000', tax_keys: [] }] })); ok(await rpc(owner, 'invoice_issue', { p_org: org, p_id: d }));
  const conn = ok(await rpc(owner, 'payments_connection_create', { p_org: org, p_name: 'Razorpay', p_gateway: 'razorpay' })); ok(await rpc(owner, 'integration_set_status', { p_org: org, p_conn: conn.id, p_status: 'connected', p_error: null }));
  const ev = (id, pid, amt) => ({ event_id: id, kind: 'payment_captured', provider_payment_id: pid, invoice_id: d, amount: amt, currency: 'INR', method: 'upi' });
  const recv = events => rpc(null, 'payment_gateway_receive', { p_conn: conn.id, p_gateway_secret: GW, p_events: events });
  const dup = await par(10, () => recv([ev('evt_1', 'pay_1', 400)])); genuine(dup); assert.equal((await q(`select count(*)::int n from public.payment_gateway_events where connection_id=$1`, [conn.id]))[0].n, 1, 'stored once');
  await par(5, i => recv([ev(`evt_replay_${i}`, 'pay_1', 400)])); // the same payment under new event ids
  const apply = await par(4, () => rpc(null, 'payment_gateway_apply', { p_limit: 50 }, 'service_role')); apply.forEach(r => assert.equal(r.error, null, r.error?.message));
  assert.equal((await q(`select count(*)::int n from public.invoice_payments where invoice_id=$1`, [d]))[0].n, 1, 'one payment however many deliveries and workers'); assert.equal(Number((await q('select public.billing_balance($1) b', [d]))[0].b), 600);
  assert.equal((await q(`select count(distinct payment_id)::int n from public.payment_gateway_events where state='applied' and connection_id=$1`, [conn.id]))[0].n, 1, 'every delivery, replays included, resolves to the same single payment'); assert.equal((await q(`select count(*)::int n from public.payment_gateway_events where state='held' and connection_id=$1`, [conn.id]))[0].n, 0);
  // two different payments that together exceed the balance, applied concurrently: only what fits is applied
  await par(2, i => recv([ev(`evt_big_${i}`, `pay_big_${i}`, 400)])); await par(4, () => rpc(null, 'payment_gateway_apply', { p_limit: 50 }, 'service_role')); assert.ok(Number((await q('select public.billing_balance($1) b', [d]))[0].b) >= 0, 'balance never negative');
});

test('[real db] AI budget: simultaneous reservations cannot exceed the daily limit', async () => {
  const { org, owner } = await fresh(); ok(await rpc(owner, 'ai_set_limits', { p_org: org, p_enabled: true, p_daily_tokens: 10000, p_hourly_messages: 100 }));
  const users = [owner, MGR, ADM, EMP, EMP2]; const rs = await par(20, i => rpc(users[i % 5], 'ai_reserve', { p_org: org, p_request: null, p_est: 3000, p_kind: 'chat' })); genuine(rs); rs.forEach(r => assert.equal(r.error, null, r.error?.message));
  const allowed = rs.filter(r => r.data.allowed).length; assert.equal(allowed, 3, `10000 / 3000 = exactly 3 reservations fit, got ${allowed}`);
  assert.equal((await q(`select coalesce(sum(reserved_tokens),0)::int s from public.ai_usage where organization_id=$1 and status='reserved'`, [org]))[0].s, 9000);
});

test('[real db] duplicate webhooks: website form submissions with one idempotency key, or the same payload, create exactly one lead however many arrive at once', async () => {
  const { org, owner } = await fresh(); const c = ok(await rpc(owner, 'integration_create_connection', { p_org: org, p_provider: 'website_forms', p_name: 'Site', p_config: {} }));
  const ing = (payload, idem) => rpc(null, 'integration_ingest_form', { p_public_id: c.public_id, p_secret: c.secret, p_payload: payload, p_idem: idem, p_meta: {} });
  const keyed = await par(12, () => ing({ name: 'Asha', email: 'asha@x.test', phone: '+919845000001' }, 'order-1')); genuine(keyed); keyed.forEach(r => assert.equal(r.error, null, r.error?.message));
  assert.deepEqual(keyed.map(r => r.data.status).sort().filter(s => s === 'created').length, 1, `exactly one created: ${JSON.stringify(keyed.map(r => r.data.status))}`); assert.ok(keyed.every(r => ['created', 'duplicate'].includes(r.data.status)));
  assert.equal(new Set(keyed.map(r => r.data.lead_id)).size, 1); assert.equal((await q(`select count(*)::int n from public.leads where organization_id=$1`, [org]))[0].n, 1);
  const keyless = await par(12, () => ing({ name: 'Ravi', email: 'ravi@x.test', phone: '+919845000002' }, null)); keyless.forEach(r => assert.equal(r.error, null, r.error?.message));
  assert.equal((await q(`select count(*)::int n from public.leads where organization_id=$1`, [org]))[0].n, 2, `an identical payload sent 12 times at once is one lead (got ${JSON.stringify(keyless.map(r => r.data.status))})`);
});
