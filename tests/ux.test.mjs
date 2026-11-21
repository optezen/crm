// Task 14 user-experience tests (invitations, roles, notifications, home data, global search): real PostgreSQL (PGlite) with migrations 0001-0019. Logic and database tests only; browser tests are in tests/browser. No provider or network is contacted.
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
const ARR = { p_branches: 'uuid', p_ids: 'uuid', p_types: 'text' };
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
const NEW = id('77'), OTHER = id('76');
const CLIENTS = { ...BASE, modules: [...CORE, { key: 'clients', label: 'Clients', status: 'active' }], objects: [{ key: 'clients', label: 'Clients', fields: [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'mobile', label: 'Mobile', kind: 'phone' }] }],
  operations: { appointments: { enabled: true, timezone: 'UTC', enforce_working_hours: false }, billing: { enabled: true, currency: 'INR', taxes: [] } } };
const addUser = async (u, email) => db.exec(`insert into auth.users values ('${u}','${email}') on conflict do nothing`);

test('invitations: link shown once, hashed at rest, role rules, expiry, revocation, wrong account, single use', async () => {
  const { org, owner } = await fresh(BASE); await addUser(NEW, 'newbie@x.test'); await addUser(OTHER, 'someone@x.test');
  const inv = (u, o = {}) => call(u, 'invite_create', { p_org: org, p_email: 'Newbie@X.test ', p_role: 'employee', p_custom_role: null, p_branches: [], p_days: 7, ...o });
  const a = await ok(inv(owner)); assert.match(a.token, /^[0-9a-f]{64}$/);
  const [row] = await q('select * from public.invitations where id=$1', [a.id]); assert.equal(row.email, 'newbie@x.test'); assert.ok(!JSON.stringify(row).includes(a.token), 'the token is not stored'); assert.equal(row.token_hash.length, 64);
  assert.equal((await rows(owner, 'select id from public.invitations')).length, 1); for (const u of [EMP, MGR]) { assert.deepEqual(await rows(u, 'select id from public.invitations'), []); await bad(inv(u), '42501'); }
  await assert.rejects(as(owner, 'select token_hash from public.invitations'), e => e.code === '42501', 'the hash column is not readable by clients');
  await bad(inv(ADM, { p_role: 'admin' }), '42501'); await bad(inv(owner, { p_email: 'nope' }), '22023'); await bad(inv(owner, { p_days: 0 }), '22023'); await bad(inv(owner, { p_days: 99 }), '22023'); await bad(inv(owner, { p_role: 'owner' }), '22023'); await bad(inv(owner, { p_email: 'emp@x.test' }), '23505');
  await bad(inv(owner, { p_branches: [id('00')] }), '22023'); await bad(inv(owner, { p_custom_role: id('00') }), 'P0002');
  // re-inviting revokes the older link
  const b = await ok(inv(owner)); assert.equal((await q('select status from public.invitations where id=$1', [a.id]))[0].status, 'revoked'); await bad(call(NEW, 'invite_accept', { p_token: a.token }), '22023');
  // preview / accept: only the invited account, only while pending, once
  assert.equal((await ok(call(NEW, 'invite_preview', { p_token: b.token }))).state, 'ready'); assert.equal((await ok(call(OTHER, 'invite_preview', { p_token: b.token }))).state, 'wrong_account'); assert.equal((await ok(call(NEW, 'invite_preview', { p_token: 'x'.repeat(64) }))).state, 'invalid');
  assert.deepEqual(Object.keys(await ok(call(OTHER, 'invite_preview', { p_token: b.token }))).sort(), ['organization', 'role', 'state'], 'nothing about other people');
  await bad(call(OTHER, 'invite_accept', { p_token: b.token }), '42501'); await assert.rejects(as(null, `select public.invite_accept('${b.token}')`), e => e.code === '42501'); await bad(call(NEW, 'invite_accept', { p_token: 'guess' }), '22023');
  assert.equal((await q('select count(*)::int n from public.organization_members where user_id=$1', [NEW]))[0].n, 0);
  assert.equal(await ok(call(NEW, 'invite_accept', { p_token: b.token })).then(String), org); assert.equal((await q('select role from public.organization_members where user_id=$1 and organization_id=$2', [NEW, org]))[0].role, 'employee');
  await bad(call(NEW, 'invite_accept', { p_token: b.token }), '22023'); // single use
  // expiry and revocation
  await addUser(id('75'), 'late@x.test'); const e = await ok(inv(owner, { p_email: 'late@x.test' })); await q(`update public.invitations set expires_at = now() - interval '1 minute' where id=$1`, [e.id]);
  assert.equal((await ok(call(id('75'), 'invite_preview', { p_token: e.token }))).state, 'expired'); await bad(call(id('75'), 'invite_accept', { p_token: e.token }), '22023');
  await addUser(id('74'), 'rev@x.test'); const r = await ok(inv(owner, { p_email: 'rev@x.test' })); await bad(call(EMP, 'invite_revoke', { p_org: org, p_id: r.id }), '42501'); const other = await fresh(BASE); await bad(call(other.owner, 'invite_revoke', { p_org: org, p_id: r.id }), '42501'); await bad(call(other.owner, 'invite_revoke', { p_org: other.org, p_id: r.id }), 'P0002');
  await ok(call(owner, 'invite_revoke', { p_org: org, p_id: r.id })); await bad(call(owner, 'invite_revoke', { p_org: org, p_id: r.id }), 'P0002'); assert.equal((await ok(call(id('74'), 'invite_preview', { p_token: r.token }))).state, 'revoked'); await bad(call(id('74'), 'invite_accept', { p_token: r.token }), '22023');
  assert.equal((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name like 'invitation.%'`, [org]))[0].n >= 4, true);
});

test('invitations can carry a custom role and branch access; roles and branches can be changed afterwards, within what each actor may do', async () => {
  const { org, owner } = await fresh(BASE); await addUser(NEW, 'newbie@x.test');
  const br = await ok(call(owner, 'branch_save', { p_org: org, p_id: null, p_name: 'North', p_active: true })); const role = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'Floor staff', p_base: 'employee', p_permissions: { contacts: { view: false } }, p_scopes: {}, p_location_restricted: false }));
  const inv = await ok(call(owner, 'invite_create', { p_org: org, p_email: 'newbie@x.test', p_role: 'employee', p_custom_role: role, p_branches: [br], p_days: 3 })); await ok(call(NEW, 'invite_accept', { p_token: inv.token }));
  const [m] = await q('select role, custom_role_id from public.organization_members where user_id=$1 and organization_id=$2', [NEW, org]); assert.deepEqual([m.role, m.custom_role_id], ['employee', role]); assert.equal((await q('select count(*)::int n from public.member_branches where user_id=$1 and branch_id=$2', [NEW, br]))[0].n, 1);
  const upd = (u, o = {}) => call(u, 'member_update_access', { p_org: org, p_user: NEW, p_role: 'manager', p_custom_role: null, p_branches: [], ...o });
  await ok(upd(owner)); assert.deepEqual((await q('select role, custom_role_id from public.organization_members where user_id=$1 and organization_id=$2', [NEW, org]))[0], { role: 'manager', custom_role_id: null }); assert.equal((await q('select count(*)::int n from public.member_branches where user_id=$1', [NEW]))[0].n, 0);
  await ok(upd(owner, { p_custom_role: role, p_branches: [br] })); assert.equal((await q('select role from public.organization_members where user_id=$1 and organization_id=$2', [NEW, org]))[0].role, 'employee', 'the custom role sets the base role');
  await bad(upd(EMP), '42501'); await bad(upd(MGR), '42501'); await bad(upd(ADM, { p_role: 'admin' }), '42501'); await bad(upd(owner, { p_role: 'owner' }), '22023'); await bad(upd(owner, { p_branches: [id('00')] }), '22023');
  await bad(call(owner, 'member_update_access', { p_org: org, p_user: owner, p_role: 'employee', p_custom_role: null, p_branches: [] }), '42501', /own role/);
  const other = await fresh(BASE); await bad(call(other.owner, 'member_update_access', { p_org: other.org, p_user: NEW, p_role: 'manager', p_custom_role: null, p_branches: [] }), 'P0002');
  assert.equal((await q('select role from public.organization_members where user_id=$1 and organization_id=$2', [NEW, org]))[0].role, 'employee', 'a failed change leaves everything as it was');
});

test('notifications: assignment and overdue are generated in-app only, respect preferences, are private, and can be marked read or unread', async () => {
  const { org, owner } = await fresh(BASE); const l = await lead(owner, org, 'Task Lead', '+919800010001', { assignee: EMP });
  const mine = async (u, cat) => rows(u, `select title, category, read_at from public.notifications where organization_id=$1 and category=$2 order by created_at`, [org, cat]);
  assert.deepEqual((await mine(EMP, 'lead_assigned')).map(n => n.title), ['A lead was assigned to you']); assert.deepEqual(await mine(EMP2, 'lead_assigned'), []);
  await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'Call back', p_owner: EMP, p_due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) }));
  assert.deepEqual((await mine(EMP, 'task_assigned')).map(n => n.title), ['New follow-up: Call back']); await ok(call(EMP, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'Self task', p_owner: EMP, p_due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) })); assert.equal((await mine(EMP, 'task_assigned')).length, 1, 'your own tasks do not notify you');
  assert.deepEqual(await rows(owner, `select 1 from public.notifications where category='task_assigned'`), [], 'private to the recipient');
  // preferences
  await ok(call(EMP, 'notification_prefs_save', { p_org: org, p_task_assigned: false, p_lead_assigned: true, p_task_overdue: true, p_automation: true }));
  await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'Muted', p_owner: EMP, p_due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) })); assert.equal((await mine(EMP, 'task_assigned')).length, 1, 'muted category creates nothing');
  assert.deepEqual(await rows(EMP2, 'select 1 from public.notification_prefs'), []); await bad(call(OTHER, 'notification_prefs_save', { p_org: org, p_task_assigned: true, p_lead_assigned: true, p_task_overdue: true, p_automation: true }), '42501');
  // overdue: once per task per day, only for the caller's own open tasks, and not claimed as a push or email
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`); // fixture insert as the system, not as the last signed-in user
  await q(`insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, created_by) values ($1,$2,'Late one',$3, current_date - 3, $4)`, [org, l, EMP, owner]);
  assert.equal(await ok(call(EMP, 'notifications_generate_overdue', { p_org: org })), 1); assert.equal(await ok(call(EMP, 'notifications_generate_overdue', { p_org: org })), 0, 'idempotent'); assert.equal(await ok(call(EMP2, 'notifications_generate_overdue', { p_org: org })), 0);
  assert.match((await mine(EMP, 'task_overdue'))[0].title, /^Overdue: Late one/);
  await ok(call(EMP, 'notification_prefs_save', { p_org: org, p_task_assigned: true, p_lead_assigned: true, p_task_overdue: false, p_automation: true })); await q(`delete from public.notifications where category='task_overdue'`); assert.equal(await ok(call(EMP, 'notifications_generate_overdue', { p_org: org })), 0, 'overdue muted');
  // read / unread
  const ids = (await rows(EMP, 'select id from public.notifications')).map(r => r.id); await ok(call(EMP, 'notifications_set_read', { p_ids: ids, p_read: true })); assert.ok((await rows(EMP, 'select read_at from public.notifications')).every(n => n.read_at));
  await ok(call(EMP, 'notifications_set_read', { p_ids: [ids[0]], p_read: false })); assert.equal((await rows(EMP, 'select 1 from public.notifications where read_at is null')).length, 1);
  await ok(call(EMP2, 'notifications_set_read', { p_ids: ids, p_read: false })); assert.equal((await rows(EMP, 'select 1 from public.notifications where read_at is null')).length, 1, 'cannot change other people\'s notifications');
});

test('profile: display names are private to the organization and optional', async () => {
  const { org, owner } = await fresh(BASE); await ok(call(EMP, 'profile_save', { p_name: '  Priya   Shah ' })); await bad(call(EMP, 'profile_save', { p_name: 'x'.repeat(81) }), '22023');
  assert.deepEqual(await ok(call(owner, 'member_names', { p_org: org })), { [EMP]: 'Priya Shah' }); assert.deepEqual(await rows(EMP2, 'select * from public.user_profiles'), []);
  const other = await fresh(BASE); await db.exec(`delete from public.organization_members where organization_id='${other.org}' and user_id='${EMP}'`); assert.deepEqual(await ok(call(other.owner, 'member_names', { p_org: other.org })), {}, 'names do not cross organizations');
  await ok(call(EMP, 'profile_save', { p_name: '' })); assert.deepEqual(await ok(call(owner, 'member_names', { p_org: org })), {});
});

// ================= global search =================
const search = (u, org, q_, o = {}) => ok(call(u, 'global_search', { p_org: org, p_q: q_, p_types: null, p_limit: 20, p_offset: 0, ...o }));
const wire = r => JSON.stringify(r);
test('global search: finds what the caller may see, never matches or shows hidden contact details, and stays inside the organization', async () => {
  const { org, owner } = await fresh(CLIENTS);
  const l1 = await lead(owner, org, 'Asha Rao', '+919861110001', { assignee: EMP, email: 'asha.private@example.com', summary: 'Wants a quote' }), l2 = await lead(owner, org, 'Ashok Hidden', '+919861110002', { assignee: EMP2 });
  await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l1, p_title: 'Send Asha the brochure', p_owner: EMP, p_due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) }));
  const rec = await ok(call(owner, 'record_create', { p_org: org, p_object: 'clients', p_data: { name: 'Asha Industries', mobile: '+919862220003' } }));
  // appointment + invoice (fixtures inserted as the system)
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  const ty = (await q(`insert into public.appointment_types (organization_id, name, duration_minutes, created_by) values ($1,'Consultation',30,$2) returning id`, [org, owner]))[0].id;
  const contact = (await q('select contact_id c from public.leads where id=$1', [l1]))[0].c;
  const ap = (await q(`insert into public.appointments (organization_id, type_id, staff_id, contact_id, starts_at, ends_at, created_by) values ($1,$2,$3,$4, now() + interval '1 day', now() + interval '1 day 30 minutes', $5) returning id`, [org, ty, EMP, contact, owner]))[0].id;
  const inv = await ok(call(MGR, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: contact, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '10', tax_keys: [] }] })); await ok(call(MGR, 'invoice_issue', { p_org: org, p_id: inv }));
  const types = r => [...new Set(r.items.map(i => i.type))].sort();
  const o = await search(owner, org, 'asha'); assert.deepEqual(types(o), ['appointment', 'invoice', 'lead', 'record', 'task'], wire(o));
  assert.equal(o.items.find(i => i.type === 'lead').link, `/work/leads/${l1}`); assert.equal(o.items.find(i => i.type === 'record').title, 'Asha Industries'); assert.equal(o.items.find(i => i.type === 'record').link, `/work/clients/${rec}`);
  // scoped by role: the employee sees their own lead/task/appointment, not other people's leads, not invoices
  const e = await search(EMP, org, 'ash'); assert.ok(e.items.some(i => i.id === l1) && !e.items.some(i => i.id === l2), 'another employee\'s lead is not found'); assert.ok(!e.items.some(i => i.type === 'invoice'), 'invoices need billing access'); assert.ok(e.items.some(i => i.type === 'task' && /brochure/.test(i.title)));
  assert.ok((await search(MGR, org, 'asha')).items.some(i => i.type === 'invoice'), 'managers find invoices'); assert.ok((await search(owner, org, 'ashok')).items.some(i => i.id === l2));
  // results carry names, numbers, stages and dates only: never a phone number or an email address
  for (const r of [o, e]) assert.ok(!/9861110001|asha\.private|9862220003|@example/.test(wire(r)), 'no contact details in any result');
  // phone / email probes: a visible number finds the lead (by name); a hidden number finds nothing, and the value is never echoed
  const byPhone = await search(EMP, org, '9861110001'); assert.deepEqual(byPhone.items.map(i => i.title), ['Asha Rao']); assert.ok(!wire(byPhone).includes('9861110001'));
  assert.deepEqual((await search(EMP, org, '9861110002')).items, [], 'a number you cannot see matches nothing'); assert.deepEqual((await search(EMP, org, 'asha.private@example.com')).items.map(i => i.id), [l1]);
  const role = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'No contacts', p_base: 'employee', p_permissions: { contacts: { view: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(owner, 'member_assign_role', { p_org: org, p_user: EMP, p_custom_role: role, p_base_if_cleared: 'employee' }));
  assert.deepEqual((await search(EMP, org, '9861110001')).items, [], 'masked contact details cannot be probed'); assert.deepEqual((await search(EMP, org, 'asha.private@example.com')).items, []); assert.ok((await search(EMP, org, 'Asha Rao')).items.some(i => i.id === l1), 'the name still works');
  assert.deepEqual((await search(EMP, org, '9862220003')).items, [], 'masked custom phone fields are not searchable either'); assert.ok(!wire(await search(EMP, org, 'asha')).match(/9862220003/));
  assert.ok((await search(owner, org, '9862220003')).items.some(i => i.type === 'record'), 'allowed roles can still find records by their own data');
  // isolation: other organizations and non-members
  const B = await fresh(BASE); await lead(B.owner, B.org, 'Asha Elsewhere', '+919863330001'); assert.ok(!wire(await search(owner, org, 'elsewhere')).includes('Elsewhere')); await bad(call(B.owner, 'global_search', { p_org: org, p_q: 'asha', p_types: null, p_limit: 5, p_offset: 0 }), '42501'); await assert.rejects(as(null, `select public.global_search('${org}','asha',null,5,0)`), e2 => e2.code === '42501');
});
test('global search: filters, pagination, input safety', async () => {
  const { org, owner } = await fresh(CLIENTS); for (let i = 1; i <= 7; i++) await lead(owner, org, `Patel ${i}`, `+91987000000${i}`);
  await lead(owner, org, '100% Match', '+919870000099'); await lead(owner, org, 'Under_score', '+919870000098');
  const p1 = await search(owner, org, 'patel', { p_limit: 3 }), p2 = await search(owner, org, 'patel', { p_limit: 3, p_offset: 3 }), p3 = await search(owner, org, 'patel', { p_limit: 3, p_offset: 6 });
  assert.deepEqual([p1.items.length, p1.has_more, p2.items.length, p2.has_more, p3.items.length, p3.has_more], [3, true, 3, true, 1, false]); assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map(i => i.id)).size, 7, 'pages do not overlap');
  assert.deepEqual((await search(owner, org, 'patel', { p_types: ['task'] })).items, []); assert.equal((await search(owner, org, 'patel', { p_types: ['lead'] })).items.length, 7);
  assert.deepEqual((await search(owner, org, '%%')).items, [], 'wildcards are literal'); assert.deepEqual((await search(owner, org, '100%')).items.map(i => i.title), ['100% Match']); assert.deepEqual((await search(owner, org, 'under_')).items.map(i => i.title), ['Under_score']); assert.deepEqual((await search(owner, org, 'x')).items, [], 'too short'); assert.deepEqual((await search(owner, org, "'; drop table leads; --")).items, []);
  await bad(call(owner, 'global_search', { p_org: org, p_q: 'x'.repeat(81), p_types: null, p_limit: 5, p_offset: 0 }), '22023'); await bad(call(owner, 'global_search', { p_org: org, p_q: 'patel', p_types: ['users'], p_limit: 5, p_offset: 0 }), '22023');
  assert.equal((await search(owner, org, 'patel', { p_limit: 9999 })).items.length, 7); assert.equal((await q('select count(*)::int n from public.leads where organization_id=$1', [org]))[0].n, 9);
  assert.deepEqual((await search(owner, org, 'patel 1')).items.map(i => i.title), ['Patel 1'], 'the query is matched as typed, not fuzzily');
});

// ================= role-aware home =================
test('home summary: my tasks, my leads, today\'s appointments and unread notifications come only from real data and the caller\'s permissions', async () => {
  const { org, owner } = await fresh(CLIENTS);
  const empty = await ok(call(EMP, 'home_summary', { p_org: org, p_tz: 'UTC' })); assert.deepEqual([empty.tasks, empty.leads, empty.appointments, empty.unread, empty.open_tasks, empty.my_leads], [[], [], [], 0, 0, 0], 'nothing is invented for an empty workspace');
  const l = await lead(owner, org, 'Home Lead', '+919880000001', { assignee: EMP }), l2 = await lead(owner, org, 'Not Mine', '+919880000002', { assignee: EMP2 }); await lead(owner, org, 'Unassigned', '+919880000003');
  const due = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'Later', p_owner: EMP, p_due: due(3) })); await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l, p_title: 'Soon', p_owner: EMP, p_due: due(1) })); await ok(call(owner, 'crm_create_task', { p_org: org, p_lead: l2, p_title: 'Theirs', p_owner: EMP2, p_due: due(1) }));
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`); await q(`insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, created_by) values ($1,$2,'Overdue',$3, current_date - 2, $4)`, [org, l, EMP, owner]);
  const h = await ok(call(EMP, 'home_summary', { p_org: org, p_tz: 'UTC' })); assert.deepEqual(h.tasks.map(t => [t.title, t.overdue]), [['Overdue', true], ['Soon', false], ['Later', false]]); assert.deepEqual([h.open_tasks, h.overdue_tasks, h.my_leads], [3, 1, 1]); assert.deepEqual(h.leads.map(x => x.name), ['Home Lead']);
  assert.ok(!JSON.stringify(h).match(/9880000|Not Mine|Theirs/), 'no one else\'s work, no contact details'); assert.equal(h.unread, 4, 'one lead and three tasks were assigned to me by someone else'); assert.equal(h.appointments_enabled, true);
  // appointments today: employees see their own, managers see everyone's
  const ty = (await q(`insert into public.appointment_types (organization_id, name, duration_minutes, created_by) values ($1,'Visit',30,$2) returning id`, [org, owner]))[0].id; const ins = (staff, hours) => q(`insert into public.appointments (organization_id, type_id, staff_id, starts_at, ends_at, created_by) values ($1,$2,$3, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '${hours} hours', date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '${hours} hours 30 minutes', $4)`, [org, ty, staff, owner]);
  await ins(EMP, 9); await ins(EMP2, 11); await ins(EMP, 30);
  assert.deepEqual((await ok(call(EMP, 'home_summary', { p_org: org, p_tz: 'UTC' }))).appointments.map(a => a.type), ['Visit']); assert.equal((await ok(call(MGR, 'home_summary', { p_org: org, p_tz: 'UTC' }))).appointments.length, 2, 'managers see the whole day; tomorrow is excluded');
  assert.equal((await ok(call(EMP, 'home_summary', { p_org: org, p_tz: 'Not/AZone' }))).today.length, 10, 'an invalid time zone falls back to UTC');
  const off = await fresh(BASE); assert.deepEqual([(await ok(call(EMP, 'home_summary', { p_org: off.org, p_tz: 'UTC' }))).appointments_enabled, (await ok(call(EMP, 'home_summary', { p_org: off.org, p_tz: 'UTC' }))).appointments], [false, []], 'modules that are off show nothing');
  await bad(call(OTHER, 'home_summary', { p_org: org, p_tz: 'UTC' }), '42501');
});
