// LIVE Supabase (local project by default): REAL concurrency for the operations modules. Parallel requests over PostgREST as real authenticated users.
// Not run by `npm test` (PGlite has one connection); run with `npm run test:integration` against a local Supabase after applying migrations 0001-0013.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, newUser, createOrg, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
after(cleanup);
let owner, staff, org;
const OPS = { schemaVersion: 1, modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }], objects: [], pipeline: { stages: ['a', 'b'] },
  operations: { appointments: { enabled: true, timezone: 'UTC', enforce_working_hours: false }, inventory: { enabled: true, track_batches: false }, billing: { enabled: true, currency: 'INR', taxes: [{ key: 'gst', name: 'GST', rate: '18' }] } } };
const rpc = async (u, fn, args) => u.client.rpc(fn, { p_org: org, ...args });

before(async () => {
  if (guard) return;
  [owner, staff] = await Promise.all(['own', 'stf'].map(newUser)); org = await createOrg(owner, 'Ops Live Org');
  const def = { ...OPS, businessName: 'Ops Live Org' };
  assert.ifError((await rpc(owner, 'save_workspace_draft', { p_definition: def })).error); assert.ifError((await rpc(owner, 'publish_workspace_config', {})).error);
  assert.ifError((await owner.client.rpc('crm_add_member', { p_org: org, p_email: staff.email, p_role: 'employee' })).error);
});

test('20 parallel bookings of the same slot: exactly one succeeds (exclusion constraint)', opt, async () => {
  const t = (await rpc(owner, 'appointment_type_save', { p_id: null, p_name: 'Visit', p_duration: 30, p_active: true })).data;
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const results = await Promise.all(Array.from({ length: 20 }, () => rpc(owner, 'appointment_create', { p_type: t, p_staff: staff.id, p_contact: null, p_lead: null, p_start: start, p_notes: null, p_custom: {} })));
  assert.equal(results.filter(r => !r.error).length, 1); assert.ok(results.filter(r => r.error).every(r => r.error.code === '23P01'));
});

test('parallel consumption never oversells and the ledger reconciles', opt, async () => {
  const loc = (await rpc(owner, 'inventory_location_save', { p_id: null, p_name: 'Main', p_active: true })).data;
  const prod = (await rpc(owner, 'product_save', { p_id: null, p_sku: 'LIVE-1', p_name: 'Live item', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null })).data;
  assert.ifError((await rpc(owner, 'stock_receive', { p_product: prod, p_location: loc, p_qty: 10, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null })).error);
  const res = await Promise.all(Array.from({ length: 30 }, () => rpc(staff, 'stock_consume', { p_product: prod, p_location: loc, p_qty: 1, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null })));
  assert.equal(res.filter(r => !r.error).length, 10, 'exactly the 10 available units were consumed');
  const lv = (await owner.client.from('stock_levels').select('quantity').eq('product_id', prod)).data; assert.equal(Number(lv[0].quantity), 0);
  assert.deepEqual((await rpc(owner, 'inventory_reconcile', {})).data, []);
});

test('parallel payments cannot exceed the invoice and numbers stay unique', opt, async () => {
  const mk = async () => { const d = (await rpc(owner, 'invoice_save_draft', { p_id: null, p_contact: null, p_lead: null, p_currency: null, p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '100', tax_keys: [] }] })).data; return d; };
  const drafts = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
  const nums = (await Promise.all(drafts.map(d => rpc(owner, 'invoice_issue', { p_id: d })))).map(r => r.data); assert.equal(new Set(nums).size, 5, 'no duplicate invoice numbers');
  const inv = drafts[0], pays = await Promise.all(Array.from({ length: 8 }, () => rpc(owner, 'payment_record', { p_invoice: inv, p_amount: 30, p_method: 'cash', p_reference: null, p_note: null, p_received: null, p_key: null })));
  assert.equal(pays.filter(r => !r.error).length, 3, '3 x 30 fits in 100, the rest are refused');
  assert.equal((await owner.client.from('invoice_balances').select('balance_due').eq('invoice_id', inv).single()).data.balance_due, '10.00'); assert.deepEqual((await rpc(owner, 'billing_reconcile', {})).data, []);
});
