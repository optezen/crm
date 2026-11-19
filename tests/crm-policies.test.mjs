// CRM engine SQL tests: real PostgreSQL engine (PGlite) running the real migration files 0001-0004.
// NOT Supabase: auth schema / auth.uid() / default grants are a small shim. Proves RLS, privileges, role rules,
// validation, history immutability and domain events; live-Supabase coverage is in tests/integration/crm.itest.mjs.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [OWN, OWN2, MGR, EMP, EMP2, ADM, NEWBIE] = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', '07'].map(id);
const def = n => ({ schemaVersion: 1, businessName: n, industryTemplate: 'clinic', modules: [], objects: [], pipeline: { stages: ['New enquiry', 'Contacted', 'Won / Lost'] } });

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rows = (user, sql, p) => as(user, sql, p).then(r => r.rows);
const rpc = (user, fn, ...args) => as(user, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then(r => r.rows[0].r);
const fails = (p, code, msg) => assert.rejects(p, e => (!code || e.code === code) && (!msg || msg.test(e.message)));
const events = async (org, name) => (await db.query('select * from public.domain_events where organization_id=$1 and event_name=$2 order by created_at', [org, name])).rows;
let ORG1, ORG2;
const newLead = (user, o = {}, org = ORG1) => rpc(user, 'crm_create_lead', org, o.name ?? 'Asha Rao', o.phone ?? null, o.email ?? null, o.source ?? 'phone', o.summary ?? null, o.stage ?? null, o.assignee ?? null);
const due = (days = 3) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${OWN}','owner1@x.test'),('${OWN2}','owner2@x.test'),('${MGR}','mgr@x.test'),('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${ADM}','admin@x.test'),('${NEWBIE}','Newbie@X.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  ORG1 = (await as(OWN, 'select public.create_organization($1,$2,$3::jsonb) id', ['Org One', 'clinic', JSON.stringify(def('Org One'))])).rows[0].id;
  ORG2 = (await as(OWN2, 'select public.create_organization($1,$2,$3::jsonb) id', ['Org Two', 'clinic', JSON.stringify(def('Org Two'))])).rows[0].id;
  await rpc(OWN, 'crm_add_member', ORG1, 'mgr@x.test', 'manager');
  await rpc(OWN, 'crm_add_member', ORG1, 'emp@x.test', 'employee');
  await rpc(OWN, 'crm_add_member', ORG1, 'emp2@x.test', 'employee');
  await rpc(OWN, 'crm_add_member', ORG1, 'admin@x.test', 'admin');
});

test('clients cannot read or write CRM tables/functions as anon; helper functions are not callable', async () => {
  await fails(as(null, 'select * from public.leads'), '42501');
  await fails(as(null, 'select public.crm_create_lead($1,$2,null,null,null,null,null,null)', [ORG1, 'x']), '42501');
  await fails(as(OWN, `select public.crm_emit($1,'lead.created','lead',$1,'{}')`, [ORG1]), '42501');
  await fails(as(OWN, `select public.crm_member_role($1)`, [ORG1]), '42501');
});

test('no direct writes to CRM tables, even for the owner', async () => {
  const lead = await newLead(OWN, { name: 'Direct Write' });
  await fails(as(OWN, `insert into public.leads (organization_id, contact_id, stage, created_by) select organization_id, contact_id, stage, created_by from public.leads limit 1`), '42501');
  await fails(as(OWN, `update public.leads set stage='x' where id=$1`, [lead]), '42501');
  await fails(as(OWN, 'delete from public.leads where id=$1', [lead]), '42501');
  await fails(as(OWN, `update public.contacts set full_name='x'`), '42501');
  await fails(as(OWN, `insert into public.domain_events (organization_id,event_name,aggregate_type,aggregate_id) values ($1,'lead.created','lead',$1)`, [ORG1]), '42501');
  await fails(as(OWN, `update public.tasks set status='done'`), '42501');
});

test('create lead: normalizes input, defaults to first pipeline stage, writes activity + lead.created event', async () => {
  const lead = await newLead(OWN, { name: '  Priya   Nair ', phone: '+91 98765-43210', email: ' Priya@Example.COM ', source: 'website', summary: ' wants a facial ' });
  const [r] = await rows(OWN, 'select * from public.crm_lead_list where id=$1', [lead]);
  assert.equal(r.full_name, 'Priya Nair'); assert.equal(r.phone, '+919876543210'); assert.equal(r.email, 'priya@example.com');
  assert.equal(r.stage, 'New enquiry'); assert.equal(r.source, 'website'); assert.equal(r.summary, 'wants a facial'); assert.equal(r.assigned_to, null);
  assert.equal((await rows(OWN, `select 1 from public.lead_activities where lead_id=$1 and kind='created'`, [lead])).length, 1);
  const ev = (await events(ORG1, 'lead.created')).find(e => e.aggregate_id === lead);
  assert.equal(ev.actor_id, OWN); assert.equal(ev.payload.stage, 'New enquiry');
});

test('create lead rejects invalid input with 22023', async () => {
  await fails(newLead(OWN, { name: '   ' }), '22023');
  await fails(newLead(OWN, { name: 'x'.repeat(121) }), '22023');
  await fails(newLead(OWN, { phone: 'abc' }), '22023');
  await fails(newLead(OWN, { phone: '123' }), '22023');
  await fails(newLead(OWN, { email: 'not-an-email' }), '22023');
  await fails(newLead(OWN, { source: 'carrier-pigeon' }), '22023');
  await fails(newLead(OWN, { stage: 'Made up stage' }), '22023');
  await fails(newLead(OWN, { summary: 'x'.repeat(2001) }), '22023');
});

test('contacts are deduplicated per organization by phone/email, and conflicts are rejected', async () => {
  const a = await newLead(OWN, { name: 'Dup One', phone: '9000000001' });
  const b = await newLead(OWN, { name: 'Dup Two (typed differently)', phone: '+9000000001'.replace('+', ''), email: 'dup@example.com' });
  const [ra] = await rows(OWN, 'select contact_id, email from public.crm_lead_list where id=$1', [a]);
  const [rb] = await rows(OWN, 'select contact_id, email from public.crm_lead_list where id=$1', [b]);
  assert.equal(ra.contact_id, rb.contact_id, 'same phone -> same contact');
  assert.equal((await rows(OWN, 'select email from public.contacts where id=$1', [ra.contact_id]))[0].email, 'dup@example.com', 'missing email filled in');
  await newLead(OWN, { name: 'Other', phone: '9000000002', email: 'other@example.com' });
  await fails(newLead(OWN, { name: 'Clash', phone: '9000000001', email: 'other@example.com' }), '23505');
  // same phone in ANOTHER organization is a different contact
  const c = await newLead(OWN2, { name: 'Dup Elsewhere', phone: '9000000001' }, ORG2);
  assert.notEqual((await rows(OWN2, 'select contact_id from public.crm_lead_list where id=$1', [c]))[0].contact_id, ra.contact_id);
});

test('tenant isolation: another organization cannot read, call into, or reference this one', async () => {
  const lead = await newLead(OWN, { name: 'Secret Lead', phone: '9111111111' });
  const task = await rpc(OWN, 'crm_create_task', ORG1, lead, 'Call back', OWN, due());
  for (const t of ['leads', 'contacts', 'lead_activities', 'tasks', 'domain_events', 'crm_lead_list'])
    assert.equal((await rows(OWN2, `select 1 from public.${t} where organization_id=$1`, [ORG1])).length, 0, `${t} hidden`);
  assert.equal((await rows(OWN2, 'select 1 from public.crm_stage_counts where organization_id=$1', [ORG1])).length, 0);
  // RPCs: using org1 id as non-member
  await fails(newLead(OWN2, {}, ORG1), '42501');
  await fails(rpc(OWN2, 'crm_add_note', ORG1, lead, 'hi'), '42501');
  await fails(rpc(OWN2, 'crm_list_members', ORG1), '42501');
  await fails(rpc(OWN2, 'crm_add_member', ORG1, 'owner2@x.test', 'employee'), '42501');
  // RPCs: own org id but another org's lead/task id
  await fails(rpc(OWN2, 'crm_add_note', ORG2, lead, 'hi'), 'P0002');
  await fails(rpc(OWN2, 'crm_set_stage', ORG2, lead, 'Contacted'), 'P0002');
  await fails(rpc(OWN2, 'crm_assign_lead', ORG2, lead, OWN2), 'P0002');
  await fails(rpc(OWN2, 'crm_complete_task', ORG2, task, 'done'), 'P0002');
  await fails(rpc(OWN2, 'crm_create_task', ORG2, lead, 'x', OWN2, due()), 'P0002');
  // cross-org assignee / task owner
  await fails(newLead(OWN2, { assignee: OWN }, ORG2), '22023');
  const own2lead = await newLead(OWN2, { name: 'Org2 lead' }, ORG2);
  await fails(rpc(OWN2, 'crm_assign_lead', ORG2, own2lead, OWN), '22023');
  await fails(rpc(OWN2, 'crm_create_task', ORG2, own2lead, 'x', OWN, due()), '22023');
  // nothing leaked/changed in org1
  assert.equal((await rows(OWN, 'select stage from public.crm_lead_list where id=$1', [lead]))[0].stage, 'New enquiry');
});

test('role access: employees see own + unassigned leads; managers+ see all; contacts follow lead visibility', async () => {
  const mine = await newLead(EMP, { name: 'Emp Mine', phone: '9222222221', assignee: EMP });
  const theirs = await newLead(MGR, { name: 'Emp2 Lead', phone: '9222222222', assignee: EMP2 });
  const open = await newLead(MGR, { name: 'Unassigned', phone: '9222222223' });
  const vis = async u => new Set((await rows(u, 'select id from public.crm_lead_list')).map(r => r.id));
  const e = await vis(EMP);
  assert.ok(e.has(mine) && e.has(open) && !e.has(theirs));
  const m = await vis(MGR); assert.ok(m.has(mine) && m.has(theirs) && m.has(open));
  assert.ok((await vis(OWN)).has(theirs) && (await vis(ADM)).has(theirs));
  assert.equal((await rows(EMP, `select 1 from public.contacts where phone='9222222222'`)).length, 0, 'contact of hidden lead hidden');
  assert.equal((await rows(EMP, `select 1 from public.contacts where phone='9222222221'`)).length, 1);
  assert.equal((await rows(EMP, 'select 1 from public.lead_activities where lead_id=$1', [theirs])).length, 0);
  await fails(rpc(EMP, 'crm_add_note', ORG1, theirs, 'snoop'), 'P0002');
  await fails(rpc(EMP, 'crm_set_stage', ORG1, theirs, 'Contacted'), 'P0002');
  await rpc(EMP, 'crm_add_note', ORG1, mine, 'ok'); // own lead is fine
  assert.equal((await rows(EMP, 'select 1 from public.domain_events')).length, 0, 'employees cannot read the event outbox');
  assert.ok((await rows(OWN, 'select 1 from public.domain_events')).length > 0);
});

test('assignment rules: managers assign anyone in the org; employees may only claim for themselves', async () => {
  const l = await newLead(MGR, { name: 'To Assign', phone: '9333333331' });
  await fails(rpc(EMP, 'crm_assign_lead', ORG1, l, EMP2), '42501');
  await rpc(EMP, 'crm_assign_lead', ORG1, l, EMP); // claim
  await fails(rpc(EMP, 'crm_assign_lead', ORG1, l, null), '42501'); // cannot release/steal logic: only claim of unassigned
  await rpc(MGR, 'crm_assign_lead', ORG1, l, EMP2);
  await fails(rpc(EMP, 'crm_add_note', ORG1, l, 'no longer mine'), 'P0002');
  await rpc(MGR, 'crm_assign_lead', ORG1, l, null);
  const ev = (await events(ORG1, 'lead.assigned')).filter(e => e.aggregate_id === l).map(e => [e.payload.from, e.payload.to]);
  assert.deepEqual(ev, [[null, EMP], [EMP, EMP2], [EMP2, null]]);
  await fails(newLead(EMP, { assignee: EMP2 }), '42501'); // employee cannot create for someone else
});

test('stage changes are validated against the published pipeline and logged', async () => {
  const l = await newLead(OWN, { name: 'Stage Test', phone: '9444444441' });
  await rpc(OWN, 'crm_set_stage', ORG1, l, 'Contacted');
  await fails(rpc(OWN, 'crm_set_stage', ORG1, l, 'Not a stage'), '22023');
  await rpc(OWN, 'crm_set_stage', ORG1, l, 'Contacted'); // no-op, no duplicate event
  const ev = (await events(ORG1, 'lead.stage_changed')).filter(e => e.aggregate_id === l);
  assert.equal(ev.length, 1); assert.deepEqual([ev[0].payload.from, ev[0].payload.to], ['New enquiry', 'Contacted']);
  assert.equal((await rows(OWN, 'select stage from public.crm_stage_counts where organization_id=$1 and stage=$2', [ORG1, 'Contacted'])).length, 1);
});

test('update lead: edits contact + lead, logs changed fields, rejects conflicts', async () => {
  const l = await newLead(OWN, { name: 'Edit Me', phone: '9555555551' });
  const other = await newLead(OWN, { name: 'Other', phone: '9555555552' });
  await rpc(OWN, 'crm_update_lead', ORG1, l, 'Edited Name', '9555555551', 'e@example.com', 'referral', 'new summary');
  const [r] = await rows(OWN, 'select * from public.crm_lead_list where id=$1', [l]);
  assert.deepEqual([r.full_name, r.email, r.source, r.summary], ['Edited Name', 'e@example.com', 'referral', 'new summary']);
  const [ev] = (await events(ORG1, 'lead.updated')).filter(e => e.aggregate_id === l);
  assert.deepEqual(ev.payload.fields.sort(), ['email', 'name', 'source', 'summary']);
  await fails(rpc(OWN, 'crm_update_lead', ORG1, l, 'Edited Name', '9555555552', 'e@example.com', 'referral', 'x'), '23505');
  await fails(rpc(OWN, 'crm_update_lead', ORG1, l, '', null, null, 'phone', null), '22023');
  assert.ok(other);
});

test('notes: stored in activity history, validated, event emitted', async () => {
  const l = await newLead(OWN, { name: 'Note Test', phone: '9666666661' });
  await rpc(OWN, 'crm_add_note', ORG1, l, '  Called, no answer  ');
  await fails(rpc(OWN, 'crm_add_note', ORG1, l, '   '), '22023');
  await fails(rpc(OWN, 'crm_add_note', ORG1, l, 'x'.repeat(4001)), '22023');
  const acts = await rows(OWN, 'select kind, body, actor_id from public.lead_activities where lead_id=$1 order by created_at, id', [l]);
  assert.deepEqual(acts.map(a => a.kind), ['created', 'note']); assert.equal(acts[1].body, 'Called, no answer'); assert.equal(acts[1].actor_id, OWN);
  assert.equal((await events(ORG1, 'lead.note_added')).filter(e => e.aggregate_id === l).length, 1);
});

test('tasks: owner, due date, status and required outcome; completion permissions; task.completed event', async () => {
  const l = await newLead(MGR, { name: 'Task Test', phone: '9777777771', assignee: EMP });
  const t = await rpc(MGR, 'crm_create_task', ORG1, l, '  Call about quote ', EMP, due(2));
  const [row] = await rows(EMP, 'select * from public.tasks where id=$1', [t]);
  assert.deepEqual([row.title, row.owner_id, row.status, row.outcome], ['Call about quote', EMP, 'open', null]);
  await fails(rpc(MGR, 'crm_create_task', ORG1, l, '', EMP, due()), '22023');
  await fails(rpc(MGR, 'crm_create_task', ORG1, l, 'x', EMP, null), '22023');
  await fails(rpc(MGR, 'crm_create_task', ORG1, l, 'x', EMP, '2001-01-01'), '22023');
  await fails(rpc(EMP, 'crm_create_task', ORG1, l, 'x', MGR, due()), '42501'); // employee: only for self
  await fails(rpc(MGR, 'crm_create_task', ORG1, l, 'x', EMP2, due()), '22023'); // EMP2 cannot open this lead
  await fails(rpc(EMP2, 'crm_complete_task', ORG1, t, 'sneaky'), 'P0002');
  await fails(rpc(EMP, 'crm_complete_task', ORG1, t, '  '), '22023'); // outcome required
  await rpc(EMP, 'crm_complete_task', ORG1, t, 'Booked consultation');
  await fails(rpc(EMP, 'crm_complete_task', ORG1, t, 'again'), '22023');
  const [done] = await rows(OWN, 'select * from public.tasks where id=$1', [t]);
  assert.deepEqual([done.status, done.outcome, done.completed_by], ['done', 'Booked consultation', EMP]); assert.ok(done.completed_at);
  const ev = (await events(ORG1, 'task.completed')).find(e => e.aggregate_id === t);
  assert.equal(ev.actor_id, EMP); assert.equal(ev.payload.lead_id, l);
  assert.equal((await events(ORG1, 'task.created')).filter(e => e.aggregate_id === t).length, 1);
  assert.equal((await rows(OWN, 'select open_tasks from public.crm_lead_list where id=$1', [l]))[0].open_tasks, 0);
});

test('team: roles gate who can add/change members; owners are immutable; membership stays tenant-scoped', async () => {
  const list = (await as(EMP, 'select * from public.crm_list_members($1)', [ORG1])).rows;
  assert.deepEqual(list.map(m => m.role), ['owner', 'admin', 'manager', 'employee', 'employee']);
  await fails(rpc(EMP, 'crm_add_member', ORG1, 'newbie@x.test', 'employee'), '42501');
  await fails(rpc(MGR, 'crm_add_member', ORG1, 'newbie@x.test', 'employee'), '42501');
  await fails(rpc(ADM, 'crm_add_member', ORG1, 'newbie@x.test', 'admin'), '42501');
  await fails(rpc(OWN, 'crm_add_member', ORG1, 'newbie@x.test', 'owner'), '22023');
  await fails(rpc(OWN, 'crm_add_member', ORG1, 'ghost@x.test', 'employee'), '22023');
  await fails(rpc(OWN, 'crm_add_member', ORG1, 'emp@x.test', 'employee'), '23505');
  await rpc(ADM, 'crm_add_member', ORG1, ' NEWBIE@x.test ', 'employee'); // case-insensitive lookup
  await fails(rpc(ADM, 'crm_set_member_role', ORG1, NEWBIE, 'admin'), '42501');
  await fails(rpc(ADM, 'crm_set_member_role', ORG1, OWN, 'employee'), '42501');
  await fails(rpc(OWN, 'crm_set_member_role', ORG1, OWN, 'employee'), '42501');
  await fails(rpc(EMP, 'crm_set_member_role', ORG1, NEWBIE, 'manager'), '42501');
  await rpc(OWN, 'crm_set_member_role', ORG1, NEWBIE, 'manager');
  assert.equal((await rows(NEWBIE, 'select public.org_role($1) r', [ORG1]))[0].r, 'manager');
  assert.deepEqual((await events(ORG1, 'member.role_changed')).map(e => [e.payload.from, e.payload.to]), [['employee', 'manager']]);
  await fails(rpc(OWN2, 'crm_set_member_role', ORG2, NEWBIE, 'manager'), 'P0002'); // not a member of org2
});

test('history is append-only for everyone, including service_role; events can only be marked processed', async () => {
  const l = await newLead(OWN, { name: 'History', phone: '9888888881' });
  await db.exec('set role service_role');
  try {
    await fails(db.query(`update public.lead_activities set body='tampered' where lead_id='${l}'`), '42501');
    await fails(db.query(`delete from public.lead_activities where lead_id='${l}'`), '42501');
    await fails(db.query(`update public.domain_events set payload='{}' where aggregate_id='${l}'`), '42501');
    await fails(db.query(`delete from public.domain_events where aggregate_id='${l}'`), '42501');
    const r = await db.query(`update public.domain_events set processed_at = now() where aggregate_id='${l}' returning id`);
    assert.equal(r.rows.length, 1);
  } finally { await db.exec('reset role'); }
});

test('deleting an organization cascades through all CRM data', async () => {
  await db.exec('set role service_role');
  try { await db.query('delete from public.organizations where id=$1', [ORG2]); } finally { await db.exec('reset role'); }
  for (const t of ['contacts', 'leads', 'lead_activities', 'tasks', 'domain_events'])
    assert.equal((await db.query(`select 1 from public.${t} where organization_id=$1`, [ORG2])).rows.length, 0, t);
});
