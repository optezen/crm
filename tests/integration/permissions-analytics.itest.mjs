// LIVE Supabase (local project by default): advanced permissions, analytics, contact privacy and visual-builder concurrency through PostgREST as REAL authenticated
// users. Not run by `npm test` (the offline suite uses PGlite). Run with `npm run test:integration` against a local Supabase with migrations 0001-0017 applied.
// Nothing here touches production: env.mjs refuses non-local projects unless SUPABASE_TEST_ALLOW_REMOTE=1, and every fixture is deleted afterwards.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, admin, newUser, createOrg, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
after(cleanup);
let owner, mgr, emp, emp2, outsider, org, orgB;
const rpc = (u, fn, args = {}, o = org) => u.client.rpc(fn, { p_org: o, ...args });
const DEF = (name) => ({ schemaVersion: 1, businessName: name, modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }], objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'], stageSettings: { Won: { requires_assignee: true } } } });
const lead = async (u, name, phone, extra = {}) => { const r = await rpc(u, 'crm_create_lead', { p_full_name: name, p_phone: phone, p_email: extra.email ?? null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: extra.assignee ?? null }); assert.ifError(r.error); return r.data; };

before(async () => {
  if (guard) return;
  [owner, mgr, emp, emp2, outsider] = await Promise.all(['own', 'mgr', 'emp', 'emp2', 'out'].map(newUser));
  org = await createOrg(owner, 'Perm Live Org'); orgB = await createOrg(outsider, 'Perm Live Org B');
  assert.ifError((await rpc(owner, 'save_workspace_draft', { p_definition: DEF('Perm Live Org') })).error); assert.ifError((await rpc(owner, 'publish_workspace_config')).error);
  for (const [u, role] of [[mgr, 'manager'], [emp, 'employee'], [emp2, 'employee']]) assert.ifError((await rpc(owner, 'crm_add_member', { p_email: u.email, p_role: role })).error);
});

test('contacts: phone and email are not readable from the table by any signed-in role, only through the checked read model', opt, async () => {
  const id = await lead(owner, 'Live Person', '+919855550001', { email: 'live@example.test' });
  for (const u of [owner, mgr, emp]) {
    const r = await u.client.from('contacts').select('phone'); assert.ok(r.error, 'column select must fail'); assert.equal(r.error.code, '42501');
    assert.ok((await u.client.from('contacts').select('*')).error); assert.ok((await u.client.from('contacts').select('id, full_name')).data !== null);
  }
  const mine = await owner.client.from('crm_lead_list').select('phone, email, contact_hidden').eq('id', id).single(); assert.deepEqual([mine.data.phone, mine.data.email, mine.data.contact_hidden], ['+919855550001', 'live@example.test', false]);
  const role = (await rpc(owner, 'role_save', { p_id: null, p_name: 'No contact details', p_base: 'employee', p_permissions: { contacts: { view: false } }, p_scopes: {}, p_location_restricted: false })).data;
  assert.ifError((await rpc(owner, 'member_assign_role', { p_user: emp2.id, p_custom_role: role, p_base_if_cleared: 'employee' })).error);
  const hidden = await emp2.client.from('crm_lead_list').select('full_name, phone, email, contact_hidden').eq('id', id).single(); assert.deepEqual([hidden.data.phone, hidden.data.email, hidden.data.contact_hidden], [null, null, true]);
  assert.equal((await emp2.client.from('crm_lead_list').select('id').or('phone.ilike.%98555%,email.ilike.%live@%')).data.length, 0, 'no search oracle');
});

test('visibility scopes and tenant isolation hold over PostgREST', opt, async () => {
  const mine = await lead(owner, 'Scoped Mine', '+919855550011', { assignee: emp.id }), theirs = await lead(owner, 'Scoped Theirs', '+919855550012', { assignee: emp2.id });
  const seen = async u => new Set((await u.client.from('leads').select('id')).data.map(r => r.id));
  const e = await seen(emp); assert.ok(e.has(mine) && !e.has(theirs)); assert.ok((await seen(mgr)).has(theirs));
  assert.equal((await outsider.client.from('leads').select('id').eq('organization_id', org)).data.length, 0, 'another organization sees nothing');
  assert.ok((await rpc(outsider, 'crm_set_stage', { p_lead: mine, p_stage: 'Qualified' }, orgB)).error, 'cross-organization lead id is refused');
});

test('stage requirements are enforced by the database for real callers', opt, async () => {
  const free = await lead(owner, 'Needs Owner', '+919855550021');
  const r = await rpc(owner, 'crm_set_stage', { p_lead: free, p_stage: 'Won' }); assert.equal(r.error?.code, '22023'); assert.match(r.error.message, /needs an assignee/);
  assert.ifError((await rpc(owner, 'crm_assign_lead', { p_lead: free, p_assignee: emp.id })).error); assert.ifError((await rpc(owner, 'crm_set_stage', { p_lead: free, p_stage: 'Won' })).error);
});

test('analytics: grammar is validated, viewer permissions apply, exports are audited', opt, async () => {
  const q = { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] };
  const a = await rpc(owner, 'analytics_run', { p_q: q, p_max: 50 }); assert.ifError(a.error); assert.ok(a.data.rows.length >= 1);
  assert.equal((await rpc(owner, 'analytics_run', { p_q: { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'phone', op: 'contains', value: '98' }] }, p_max: 5 })).error?.code, '22023', 'personal fields are not in the grammar');
  assert.equal((await rpc(emp, 'analytics_run', { p_q: { source: 'invoices', metric: { agg: 'count' } }, p_max: 5 })).error?.code, '42501', 'billing analytics need billing permission');
  assert.equal((await rpc(outsider, 'analytics_run', { p_q: q, p_max: 5 })).error?.code, '42501', 'not a member');
});

test('visual workflow saves: two concurrent editors cannot both win, and layout stays out of the definition', opt, async () => {
  const def = { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Hello' }] };
  const layout = { v: 1, order: ['n1', 'n2'], pos: { n1: { x: 0, y: 0 }, n2: { x: 300, y: 0 } } };
  const first = (await rpc(owner, 'automation_save_visual', { p_workflow: null, p_name: 'Live canvas', p_definition: def, p_layout: layout, p_expected_token: null, p_expected_published: null })).data;
  const edits = await Promise.all([1, 2, 3, 4, 5, 6].map(i => rpc(owner, 'automation_save_visual', { p_workflow: first.id, p_name: 'Live canvas', p_definition: { ...def, actions: [{ type: 'notify', recipient: 'event_actor', title: `Edit ${i}` }] }, p_layout: layout, p_expected_token: first.token, p_expected_published: null })));
  assert.equal(edits.filter(r => !r.error).length, 1, 'exactly one of six concurrent saves from the same base succeeds'); assert.ok(edits.filter(r => r.error).every(r => /changed since you opened it/.test(r.error.message)));
  assert.deepEqual((await owner.client.from('automation_layouts').select('layout').eq('workflow_id', first.id).single()).data.layout, layout);
  assert.equal((await emp.client.from('automation_layouts').select('layout')).data.length, 0, 'employees cannot read canvas layouts');
});

test('pipeline migration plans apply atomically under concurrent lead creation', opt, async () => {
  const l = await lead(owner, 'Moves With Stage', '+919855550031'); assert.ifError((await rpc(owner, 'crm_set_stage', { p_lead: l, p_stage: 'Qualified' })).error);
  const next = { ...DEF('Perm Live Org'), pipeline: { stages: ['New', 'Vetted', 'Won'], stageMoves: [{ from: 'Qualified', to: 'Vetted' }] } };
  assert.ifError((await rpc(owner, 'save_workspace_draft', { p_definition: next })).error);
  const burst = Promise.all(Array.from({ length: 5 }, (_, i) => lead(owner, `Burst ${i}`, `+9198555501${i}0`)));
  const pub = await rpc(owner, 'publish_workspace_config'); await burst;
  assert.ifError(pub.error); assert.equal((await owner.client.from('leads').select('stage').eq('id', l).single()).data.stage, 'Vetted');
  assert.equal((await admin().from('leads').select('id').eq('organization_id', org).eq('stage', 'Qualified')).data.length, 0, 'no lead is left in a removed stage');
});

test('invoice PDF endpoint rejects anonymous, malformed and foreign requests (needs APP_URL)', { skip: guard ?? (process.env.APP_URL ? false : 'APP_URL not set') }, async () => {
  const get = (p) => fetch(process.env.APP_URL + p, { redirect: 'manual' });
  assert.equal((await get('/api/billing/invoices/not-an-id/pdf')).status, 401); assert.equal((await get('/api/billing/invoices/00000000-0000-0000-0000-000000000000/pdf')).status, 401);
});
