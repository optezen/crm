// Permissions engine tests: real PostgreSQL (PGlite) with migrations 0001-0016. Custom roles NARROW base roles; every restriction is enforced by RLS policies, triggers and function checks.
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

import { permDefault, PERM_MODULES, PERM_ACTIONS } from '../src/lib/permissions/defaults.ts';

const role = (o, name, base, permissions = {}, scopes = {}, loc = false) => call(o.owner, 'role_save', { p_org: o.org, p_id: null, p_name: name, p_base: base, p_permissions: permissions, p_scopes: scopes, p_location_restricted: loc });
const assign = (o, user, roleId, actor = o.owner) => call(actor, 'member_assign_role', { p_org: o.org, p_user: user, p_custom_role: roleId, p_base_if_cleared: 'employee' });
const myLeads = (u, org) => rows(u, 'select c.full_name from public.leads l join public.contacts c on c.id = l.contact_id where l.organization_id = $1 order by c.full_name', [org]).then(r => r.map(x => x.full_name));

test('custom roles can only NARROW a base role: validation, administration and assignment rules', async () => {
  const o = await fresh();
  await ok(role(o, 'Viewer', 'employee', { leads: { view: true, create: false, edit: false } }, { leads: 'assigned' }, false));
  await bad(role(o, 'viewer', 'employee'), '23505', /already exists/);
  for (const [perms, scopes, re] of [[{ nope: { view: true } }, {}, /Unknown module/], [{ leads: { fly: true } }, {}, /Invalid permission/], [{ leads: { view: 'yes' } }, {}, /Invalid permission/], [{ leads: [] }, {}, /Unknown module/],
    [{ billing: { view: true } }, {}, /can only narrow/], [{ integrations: { edit: true } }, {}, /can only narrow/], [{ leads: { archive: true } }, {}, /can only narrow/], [{}, { leads: 'everyone' }, /Invalid visibility/], [{}, { dashboards: 'own' }, /Invalid visibility/], [{ 'custom:Bad Key': { view: true } }, {}, /Unknown module/]])
    await bad(role(o, 'Bad', 'employee', perms, scopes), '22023', re);
  await bad(role(o, 'Owner', 'owner'), '22023', /based on admin, manager or employee/); await ok(role(o, 'Mgr no billing', 'manager', { billing: { view: false } }));
  // narrowing only: even if the stored permissions are tampered with, the base role caps them
  const tamper = await ok(role(o, 'Tampered', 'employee')); await db.exec(`update public.custom_roles set permissions = '{"billing":{"view":true,"approve":true}}' where id = '${tamper}'`); await ok(assign(o, EMP, tamper));
  assert.equal((await ok(call(EMP, 'my_permissions', { p_org: o.org }))).permissions.billing.view, false, 'base employee still has no billing access');
  await ok(assign(o, EMP, null));
  // who can administer roles
  for (const u of [EMP, MGR]) { await bad(call(u, 'role_save', { p_org: o.org, p_id: null, p_name: 'X', p_base: 'employee', p_permissions: {}, p_scopes: {}, p_location_restricted: false }), '42501'); await bad(call(u, 'team_directory', { p_org: o.org }), '42501'); await bad(call(u, 'branch_save', { p_org: o.org, p_id: null, p_name: 'B', p_active: true }), '42501'); }
  await bad(call(ADM, 'role_save', { p_org: o.org, p_id: null, p_name: 'Adminish', p_base: 'admin', p_permissions: {}, p_scopes: {}, p_location_restricted: false }), '42501', /Only the owner/);
  const adminRole = await ok(role(o, 'Admin lite', 'admin', { integrations: { edit: false } })); const viewer = (await q(`select id from public.custom_roles where organization_id=$1 and name='Viewer'`, [o.org]))[0].id;
  await bad(assign(o, EMP, adminRole, ADM), '42501', /Only the owner/); await ok(assign(o, EMP, viewer, ADM));
  const eff = (await q(`select role, custom_role_id from public.organization_members where organization_id=$1 and user_id=$2`, [o.org, EMP]))[0]; assert.deepEqual([eff.role, eff.custom_role_id], ['employee', viewer], 'the effective base role is stored, so every older role check still works');
  await bad(assign(o, o.owner, viewer), '42501'); await bad(assign(o, ADM, viewer, ADM), '42501'); await bad(assign(o, EMP2, id('99')), 'P0002'); await bad(assign(o, id('99'), viewer), 'P0002');
  await bad(call(o.owner, 'role_delete', { p_org: o.org, p_id: viewer }), '22023', /Move the members/); await bad(call(o.owner, 'role_save', { p_org: o.org, p_id: viewer, p_name: 'Viewer', p_base: 'manager', p_permissions: {}, p_scopes: {}, p_location_restricted: false }), '22023', /cannot change/);
  // changing the base role through the older function clears an overlay that no longer fits
  await ok(call(o.owner, 'crm_set_member_role', { p_org: o.org, p_user: EMP, p_role: 'manager' })); assert.equal((await q(`select custom_role_id from public.organization_members where organization_id=$1 and user_id=$2`, [o.org, EMP]))[0].custom_role_id, null);
  const dir_ = (await ok(call(o.owner, 'team_directory', { p_org: o.org }))); assert.equal(dir_.length, 5);
  await ok(assign(o, EMP, null)); await ok(call(o.owner, 'role_delete', { p_org: o.org, p_id: viewer }));
});

test('module permissions and record visibility are enforced by PostgreSQL, whichever function performs the write', async () => {
  const o = await fresh(); const b1 = await ok(call(o.owner, 'branch_save', { p_org: o.org, p_id: null, p_name: 'North', p_active: true })), b2 = await ok(call(o.owner, 'branch_save', { p_org: o.org, p_id: null, p_name: 'South', p_active: true }));
  const mine = await lead(o.owner, o.org, 'Mine', '9100000001', { assignee: EMP }), other = await lead(o.owner, o.org, 'Colleague', '9100000002', { assignee: EMP2 }), mgrs = await lead(o.owner, o.org, 'Managers', '9100000003', { assignee: MGR }), free = await lead(o.owner, o.org, 'Unassigned', '9100000004');
  const mkTask = (lead_, owner) => ok(call(o.owner, 'crm_create_task', { p_org: o.org, p_lead: lead_, p_title: 'T', p_owner: owner, p_due: days(2) }));
  await mkTask(mine, EMP); const t2 = await mkTask(other, EMP2);
  assert.deepEqual(await myLeads(EMP, o.org), ['Mine', 'Unassigned'], 'default employee: own + unassigned (existing behavior, unchanged)');
  const R = async (name, base, perms, scopes, loc) => ok(role(o, name, base, perms, scopes, loc));
  // scope: assigned
  await ok(assign(o, EMP, await R('Assigned only', 'employee', {}, { leads: 'assigned' }))); assert.deepEqual(await myLeads(EMP, o.org), ['Mine'], 'assigned scope: only leads assigned to me (unassigned ones are hidden)');
  // scope: own (created by me): EMP created nothing
  await ok(assign(o, EMP, await R('Own only', 'employee', {}, { leads: 'own' }))); assert.deepEqual(await myLeads(EMP, o.org), [], 'nothing was created by this person');
  const made = await lead(EMP, o.org, 'Made by EMP', '9100000009'); assert.deepEqual(await myLeads(EMP, o.org), ['Made by EMP']);
  // scope: team = people who share a branch. A manager-based role normally sees everything; with the team scope it sees only itself and its branch mates.
  await ok(assign(o, MGR, await R('Team manager', 'manager', {}, { leads: 'team' }))); assert.deepEqual(await myLeads(MGR, o.org), ['Managers'], 'no branch yet: only my own');
  await ok(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: MGR, p_branches: `{${[b1].join(',')}}` })); await ok(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: EMP, p_branches: `{${[b1].join(',')}}` })); await ok(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: EMP2, p_branches: `{${[b2].join(',')}}` }));
  assert.deepEqual(await myLeads(MGR, o.org), ['Made by EMP', 'Managers', 'Mine'], 'my branch mates, not the other branch, not unassigned leads created elsewhere');
  await ok(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: EMP2, p_branches: `{${[b1].join(',')}}` })); assert.deepEqual(await myLeads(MGR, o.org), ['Colleague', 'Made by EMP', 'Managers', 'Mine']);
  await ok(call(o.owner, 'member_assign_role', { p_org: o.org, p_user: MGR, p_custom_role: null, p_base_if_cleared: 'manager' })); assert.equal((await myLeads(MGR, o.org)).length, 5, 'clearing the role restores the manager default');
  // action permissions
  const cant = await R('Read-mostly', 'employee', { leads: { create: false, edit: false, assign: false }, tasks: { create: false, edit: false } }, {}); await ok(assign(o, EMP, cant));
  await bad(call(EMP, 'crm_create_lead', { p_org: o.org, p_full_name: 'Nope', p_phone: '9100000050', p_email: null, p_source: 'phone', p_summary: null, p_stage: null, p_assigned_to: null }), '42501', /does not allow you to create/);
  await bad(call(EMP, 'crm_update_lead', { p_org: o.org, p_lead: mine, p_full_name: 'Mine2', p_phone: '9100000001', p_email: null, p_source: 'phone', p_summary: null }), '42501', /edit/);
  await bad(call(EMP, 'crm_assign_lead', { p_org: o.org, p_lead: free, p_assignee: EMP }), '42501', /assign/);
  await ok(call(EMP, 'crm_add_note', { p_org: o.org, p_lead: mine, p_body: 'Called them' })); // touching updated_at is not an edit
  await bad(call(EMP, 'crm_create_task', { p_org: o.org, p_lead: mine, p_title: 'x', p_owner: EMP, p_due: days(1) }), '42501', /create/);
  await bad(call(EMP, 'crm_complete_task', { p_org: o.org, p_task: (await q(`select id from public.tasks where lead_id=$1`, [mine]))[0].id, p_outcome: 'done' }), '42501', /edit/);
  // tasks: view denied -> invisible; custom module records follow their own permission key
  await ok(assign(o, EMP, await R('No tasks', 'employee', { tasks: { view: false } }, {}))); assert.equal((await rows(EMP, 'select 1 from public.tasks where organization_id=$1', [o.org])).length, 0); assert.ok((await rows(MGR, 'select 1 from public.tasks where organization_id=$1', [o.org])).length > 0);
  const rec = await ok(call(o.owner, 'record_create', { p_org: o.org, p_object: 'vehicles', p_data: { registration: 'KA01' } })); await ok(call(EMP2, 'record_create', { p_org: o.org, p_object: 'vehicles', p_data: { registration: 'KA02' } }));
  await ok(assign(o, EMP, await R('No vehicles', 'employee', { 'custom:vehicles': { view: false, create: false } }, {}))); assert.equal((await rows(EMP, 'select 1 from public.records where organization_id=$1', [o.org])).length, 0); await bad(call(EMP, 'record_create', { p_org: o.org, p_object: 'vehicles', p_data: { registration: 'X' } }), '42501');
  await ok(assign(o, EMP, await R('Own vehicles', 'employee', {}, { 'custom:vehicles': 'own' }))); assert.equal((await rows(EMP, 'select 1 from public.records where organization_id=$1', [o.org])).length, 0); await ok(call(EMP, 'record_create', { p_org: o.org, p_object: 'vehicles', p_data: { registration: 'KA03' } })); assert.equal((await rows(EMP, 'select 1 from public.records where organization_id=$1', [o.org])).length, 1);
  await bad(call(EMP, 'record_update', { p_org: o.org, p_record: rec, p_data: { registration: 'hack' } }), '42501');
  // financial data: a manager-based role can be denied billing entirely, or only denied approval
  const inv = await ok(call(MGR, 'invoice_save_draft', { p_org: o.org, p_id: null, p_contact: null, p_lead: null, p_currency: null, p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '100' }] }));
  await ok(assign(o, MGR, await R('Billing clerk', 'manager', { billing: { approve: false } }, {}))); await bad(call(MGR, 'invoice_issue', { p_org: o.org, p_id: inv }), '42501', /approve/);
  await ok(call(MGR, 'invoice_save_draft', { p_org: o.org, p_id: inv, p_contact: null, p_lead: null, p_currency: null, p_due_date: null, p_notes: 'edited', p_lines: [{ description: 'x', quantity: '1', unit_price: '120' }] }));
  await ok(assign(o, MGR, await R('No billing', 'manager', { billing: { view: false } }, {}))); assert.equal((await rows(MGR, 'select 1 from public.invoices where organization_id=$1', [o.org])).length, 0); assert.equal((await rows(MGR, 'select 1 from public.invoice_ledger')).length, 0);
  assert.equal((await ok(call(MGR, 'ai_tool_list_invoices', { p_org: o.org, p_state: null, p_limit: 5, p_offset: 0 }))).total, 0, 'the assistant sees nothing the user cannot see');
  assert.equal((await ok(call(o.owner, 'ai_tool_list_invoices', { p_org: o.org, p_state: null, p_limit: 5, p_offset: 0 }))).total, 1, 'the owner is unaffected');
  // AI tools run as the user, so the same restrictions apply to what the assistant can read
  await ok(assign(o, EMP, await R('Assigned only 2', 'employee', {}, { leads: 'assigned' }))); assert.deepEqual((await ok(call(EMP, 'ai_tool_list_leads', { p_org: o.org, p_stage: null, p_source: null, p_assignee: null, p_search: null, p_limit: 25, p_offset: 0 }))).items.map(i => i.name).sort(), ['Made by EMP', 'Mine']);
  void t2; void made; void mgrs;
});

test('location restrictions and branch assignment for stock; the ledger cannot be written outside your locations', async () => {
  const o = await fresh(); const north = await ok(call(o.owner, 'branch_save', { p_org: o.org, p_id: null, p_name: 'North', p_active: true })), south = await ok(call(o.owner, 'branch_save', { p_org: o.org, p_id: null, p_name: 'South', p_active: true }));
  const LN = await ok(call(o.owner, 'inventory_location_save', { p_org: o.org, p_id: null, p_name: 'North store', p_active: true })), LS = await ok(call(o.owner, 'inventory_location_save', { p_org: o.org, p_id: null, p_name: 'South store', p_active: true })), LC = await ok(call(o.owner, 'inventory_location_save', { p_org: o.org, p_id: null, p_name: 'Central', p_active: true }));
  await ok(call(o.owner, 'location_branch_set', { p_org: o.org, p_location: LN, p_branch: north })); await ok(call(o.owner, 'location_branch_set', { p_org: o.org, p_location: LS, p_branch: south }));
  const P = await ok(call(o.owner, 'product_save', { p_org: o.org, p_id: null, p_sku: 'P1', p_name: 'Prod', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null }));
  for (const L of [LN, LS, LC]) await ok(call(o.owner, 'stock_receive', { p_org: o.org, p_product: P, p_location: L, p_qty: 10, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }));
  const seen = u => rows(u, 'select l.name from public.stock_levels s join public.inventory_locations l on l.id = s.location_id where s.organization_id=$1 order by l.name', [o.org]).then(r => r.map(x => x.name));
  assert.deepEqual(await seen(MGR), ['Central', 'North store', 'South store'], 'unrestricted: everything');
  const north_only = await ok(call(o.owner, 'role_save', { p_org: o.org, p_id: null, p_name: 'Branch manager', p_base: 'manager', p_permissions: {}, p_scopes: {}, p_location_restricted: true })); await ok(call(o.owner, 'member_assign_role', { p_org: o.org, p_user: MGR, p_custom_role: north_only, p_base_if_cleared: 'manager' }));
  assert.deepEqual(await seen(MGR), ['Central'], 'restricted role without branches: only unassigned (shared) locations'); await ok(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: MGR, p_branches: `{${[north].join(',')}}` })); assert.deepEqual(await seen(MGR), ['Central', 'North store']);
  assert.equal((await rows(MGR, 'select * from public.inventory_reconcile_v2($1)', [o.org])).length, 0);
  await ok(call(MGR, 'stock_consume', { p_org: o.org, p_product: P, p_location: LN, p_qty: 1, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null }));
  await bad(call(MGR, 'stock_consume', { p_org: o.org, p_product: P, p_location: LS, p_qty: 1, p_batch: null, p_ref_type: null, p_ref_id: null, p_reason: null }), '42501', /cannot use that location/);
  await bad(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: LN, p_to: LS, p_batch: null, p_qty: 1, p_reason: null }), '42501'); await bad(call(MGR, 'stock_receive', { p_org: o.org, p_product: P, p_location: LS, p_qty: 1, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }), '42501');
  assert.equal(Number((await q(`select quantity from public.stock_levels where location_id=$1`, [LS]))[0].quantity), 10, 'nothing changed in the other branch');
  assert.equal((await rows(MGR, 'select 1 from public.inventory_on_hand where organization_id=$1 and on_hand = 19', [o.org])).length, 1, 'on-hand totals only count the locations this role can see (Central + North = 19, not 29)');
  // branches and locations are tenant scoped
  const B = await fresh(); const bb = await ok(call(B.owner, 'branch_save', { p_org: B.org, p_id: null, p_name: 'North', p_active: true })); // same name in another org is fine
  await bad(call(o.owner, 'member_branches_set', { p_org: o.org, p_user: MGR, p_branches: `{${[bb].join(',')}}` }), '22023', /Unknown branch/); await bad(call(o.owner, 'location_branch_set', { p_org: o.org, p_location: LN, p_branch: bb }), '22023'); await bad(call(B.owner, 'location_branch_set', { p_org: B.org, p_location: LN, p_branch: bb }), 'P0002');
  assert.equal((await rows(B.owner, 'select 1 from public.branches where organization_id=$1', [o.org])).length, 0); assert.equal((await rows(B.owner, 'select 1 from public.member_branches where organization_id=$1', [o.org])).length, 0);
});

test('no permission configuration grants cross-organization access; a person with roles in two organizations is evaluated per organization', async () => {
  const A = await fresh(), B = await fresh(); await lead(A.owner, A.org, 'A lead', '9200000001', { assignee: EMP }); await lead(B.owner, B.org, 'B lead', '9200000002', { assignee: EMP });
  // EMP belongs to both organizations; in A they are tightly restricted, in B they have no custom role
  const tight = await ok(call(A.owner, 'role_save', { p_org: A.org, p_id: null, p_name: 'Tight', p_base: 'employee', p_permissions: { leads: { view: false }, tasks: { view: false } }, p_scopes: {}, p_location_restricted: true })); await ok(call(A.owner, 'member_assign_role', { p_org: A.org, p_user: EMP, p_custom_role: tight, p_base_if_cleared: 'employee' }));
  assert.deepEqual(await myLeads(EMP, A.org), []); assert.deepEqual(await myLeads(EMP, B.org), ['B lead'], "A's restrictions do not leak into B");
  // roles, branches and permissions of one organization are invisible and unusable in another
  assert.equal((await rows(B.owner, 'select 1 from public.custom_roles where organization_id=$1', [A.org])).length, 0);
  await bad(call(B.owner, 'member_assign_role', { p_org: B.org, p_user: EMP2, p_custom_role: tight, p_base_if_cleared: 'employee' }), 'P0002', /Role not found/); await bad(call(B.owner, 'member_assign_role', { p_org: A.org, p_user: EMP2, p_custom_role: tight, p_base_if_cleared: 'employee' }), '42501');
  await bad(call(B.owner, 'role_save', { p_org: A.org, p_id: tight, p_name: 'Hijack', p_base: 'employee', p_permissions: {}, p_scopes: {}, p_location_restricted: false }), '42501'); await bad(call(B.owner, 'role_delete', { p_org: B.org, p_id: tight }), 'P0002');
  await bad(call(B.owner, 'my_permissions', { p_org: A.org }), '42501'); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); assert.equal((await q(`select public.perm_ok($1, 'leads', 'view') r`, [A.org]))[0].r, true, 'system context (no signed-in user) is not a member overlay');
  assert.equal((await as(B.owner, `select public.perm_ok($1, 'leads', 'view') r`, [A.org])).rows[0].r, false, 'a non-member is never granted anything');
  for (const [fn, args] of [['analytics_catalog', {}], ['analytics_run', { p_q: { source: 'leads', metric: { agg: 'count' } } }], ['dashboard_save', { p_id: null, p_name: 'x', p_description: null, p_visibility: 'personal', p_widgets: [], p_version: null }]]) await bad(call(B.owner, fn, { p_org: A.org, ...args }), '42501');
  assert.equal((await ok(call(A.owner, 'my_permissions', { p_org: A.org }))).role, 'owner'); assert.equal((await ok(call(EMP, 'my_permissions', { p_org: A.org }))).custom_role, 'Tight');
  // an owner overlay can never exist
  await db.exec(`update public.organization_members set custom_role_id = '${tight}' where organization_id='${A.org}' and user_id='${A.owner}'`).catch(() => {}); const own = (await q(`select custom_role_id from public.organization_members where organization_id=$1 and user_id=$2`, [A.org, A.owner]))[0]; assert.equal(own.custom_role_id, null, 'the trigger clears overlays on owners');
});

test('automations, integrations and system actors respect permissions', async () => {
  const o = await fresh(); const lim = await ok(call(o.owner, 'role_save', { p_org: o.org, p_id: null, p_name: 'Admin no assign', p_base: 'admin', p_permissions: { leads: { assign: false }, integrations: { edit: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(o.owner, 'member_assign_role', { p_org: o.org, p_user: ADM, p_custom_role: lim, p_base_if_cleared: 'admin' }));
  // integration management needs integrations.edit even for an admin-based role
  await bad(call(ADM, 'integration_create_connection', { p_org: o.org, p_provider: 'website_forms', p_name: 'Site', p_config: {} }), '42501'); const conn = await ok(call(o.owner, 'integration_create_connection', { p_org: o.org, p_provider: 'website_forms', p_name: 'Site', p_config: {} }));
  // an automation may only be published if its publisher holds the permissions its actions need
  const def = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }] };
  const wfA = await ok(call(ADM, 'automation_save_draft', { p_org: o.org, p_workflow: null, p_name: 'Assign', p_definition: def })); await bad(call(ADM, 'automation_publish', { p_org: o.org, p_workflow: wfA, p_enable: true }), '42501', /cannot assign leads/);
  const okDef = { trigger: { event: 'lead.created' }, actions: [{ type: 'create_task', title: 'x', due_in_days: 1, owner: EMP }] }; await ok(call(ADM, 'automation_save_draft', { p_org: o.org, p_workflow: wfA, p_name: 'Task', p_definition: okDef })); assert.equal(await ok(call(ADM, 'automation_publish', { p_org: o.org, p_workflow: wfA, p_enable: true })), 1);
  // and at run time: if the publisher loses the permission afterwards, runs are refused (dead-lettered) instead of acting with stale rights
  const tasks = await ok(call(o.owner, 'role_save', { p_org: o.org, p_id: lim, p_name: 'Admin no assign', p_base: 'admin', p_permissions: { leads: { assign: false }, integrations: { edit: false }, tasks: { create: false } }, p_scopes: {}, p_location_restricted: false }));
  await lead(o.owner, o.org, 'Run me', '9300000001'); await drain(); const [run] = await q('select status, last_error from public.automation_runs where organization_id=$1', [o.org]); assert.deepEqual([run.status, run.last_error], ['dead', 'The publisher cannot create tasks.']); void tasks;
  assert.equal((await q('select count(*)::int n from public.tasks where organization_id=$1', [o.org]))[0].n, 0);
  // integration principals (no signed-in user) are not subject to member overlays: forms still create leads
  const r = await ok(call(null, 'integration_ingest_form', { p_public_id: conn.public_id, p_secret: conn.secret, p_payload: { name: 'Web', phone: '9300000002' }, p_idem: null, p_meta: {} })); assert.equal(r.status, 'created');
  // exports honour the module's export permission
  assert.equal((await bad(call(EMP, 'analytics_export', { p_org: o.org, p_q: { source: 'leads', metric: { agg: 'count' } } }), '42501')).code, '42501'); assert.ok((await ok(call(MGR, 'analytics_export', { p_org: o.org, p_q: { source: 'leads', metric: { agg: 'count' } } }))).row_count >= 1);
  const noExport = await ok(call(o.owner, 'role_save', { p_org: o.org, p_id: null, p_name: 'No export', p_base: 'manager', p_permissions: { leads: { export: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(o.owner, 'member_assign_role', { p_org: o.org, p_user: MGR, p_custom_role: noExport, p_base_if_cleared: 'manager' }));
  await bad(call(MGR, 'analytics_export', { p_org: o.org, p_q: { source: 'leads', metric: { agg: 'count' } } }), '42501', /cannot export/); assert.ok((await ok(call(MGR, 'analytics_run', { p_org: o.org, p_q: { source: 'leads', metric: { agg: 'count' } } }))).row_count >= 1, 'viewing is still allowed');
});

test('the TypeScript permission defaults (used to draw the role editor) are identical to the database defaults', async () => {
  const mods = [...PERM_MODULES, 'custom:vehicles', 'custom:anything'];
  for (const role_ of ['owner', 'admin', 'manager', 'employee']) for (const m of mods) for (const a of PERM_ACTIONS) assert.equal(permDefault(role_, m, a), (await q('select public.perm_default($1,$2,$3) r', [role_, m, a]))[0].r, `${role_}/${m}/${a}`);
});
