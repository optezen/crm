// LIVE Supabase: the CRM service (the same functions the UI calls) as real authenticated users through PostgREST + RLS.
// Fixtures (users, orgs) are created/deleted with the service role; every assertion runs as a user.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, newUser, createOrg, cleanup } from './env.mjs';
import * as crm from '../../src/lib/crm/service.ts';
import { PAGE_SIZE } from '../../src/lib/crm/types.ts';
import { parseListParams } from '../../src/lib/crm/validate.ts';

const opt = { skip: guard ?? false };
const STAGES = ['a', 'b'];
let owner, mgr, emp, emp2, other, orgA, orgB, O, M, E, E2, X;
const ctx = (u, organizationId, role) => ({ db: u.client, organizationId, userId: u.id, role, stages: STAGES });
const ok = r => { assert.ok(r.ok, r.error); return r.value; };
const due = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  if (guard) return;
  [owner, mgr, emp, emp2, other] = await Promise.all(['own', 'mgr', 'emp', 'emp2', 'oth'].map(newUser));
  orgA = await createOrg(owner, 'CRM Org A'); orgB = await createOrg(other, 'CRM Org B');
  O = ctx(owner, orgA, 'owner'); X = ctx(other, orgB, 'owner');
  for (const [u, role] of [[mgr, 'manager'], [emp, 'employee'], [emp2, 'employee']]) ok(await crm.addMember(O, u.email.toUpperCase(), role));
  M = ctx(mgr, orgA, 'manager'); E = ctx(emp, orgA, 'employee'); E2 = ctx(emp2, orgA, 'employee');
});
after(cleanup);

test('team: members listed with roles; employees cannot manage the team; owner role is immutable', opt, async () => {
  assert.deepEqual(ok(await crm.listMembers(E)).map(m => m.role), ['owner', 'manager', 'employee', 'employee']);
  assert.equal((await crm.addMember(E, other.email, 'employee')).ok, false);
  assert.equal((await crm.addMember(O, 'nobody-here@example.test', 'employee')).ok, false);
  assert.equal((await crm.addMember(O, emp.email, 'employee')).ok, false); // already a member
  assert.equal((await crm.setMemberRole(O, owner.id, 'employee')).ok, false);
  ok(await crm.setMemberRole(O, emp2.id, 'manager')); ok(await crm.setMemberRole(O, emp2.id, 'employee'));
});

test('lead lifecycle: create (normalized + contact dedupe) -> edit -> stage -> assign -> note -> task -> complete', opt, async () => {
  const { id } = ok(await crm.createLead(O, { fullName: '  Live   Lead ', phone: '+91 98765-00001', email: ' LIVE@Example.com ', source: 'website', summary: 'needs help' }));
  let d = ok(await crm.getLead(O, id));
  assert.deepEqual([d.lead.fullName, d.lead.phone, d.lead.email, d.lead.stage, d.lead.assignedTo], ['Live Lead', '+919876500001', 'live@example.com', 'a', null]);
  const again = ok(await crm.createLead(O, { fullName: 'Same Phone', phone: '919876500001'.replace(/^91/, '+91') }));
  assert.equal(ok(await crm.getLead(O, again.id)).lead.contactId, d.lead.contactId, 'same phone reuses the contact');

  ok(await crm.updateLead(O, id, { fullName: 'Live Lead 2', phone: '+919876500001', email: 'live@example.com', source: 'referral', summary: '' }));
  ok(await crm.setStage(O, id, 'b'));
  assert.equal((await crm.setStage(O, id, 'zzz')).ok, false);
  ok(await crm.assignLead(O, id, emp.id));
  ok(await crm.addNote(E, id, 'Called, will visit Friday'));
  const t = ok(await crm.createTask(M, { leadId: id, title: 'Confirm visit', ownerId: emp.id, dueDate: due(2) }));
  assert.equal((await crm.completeTask(E, t.id, '  ')).ok, false);
  assert.equal((await crm.completeTask(E2, t.id, 'not mine')).ok, false);
  ok(await crm.completeTask(E, t.id, 'Confirmed for Friday'));
  assert.equal((await crm.completeTask(E, t.id, 'again')).ok, false);

  d = ok(await crm.getLead(O, id));
  assert.deepEqual([d.lead.fullName, d.lead.source, d.lead.stage, d.lead.assignedTo, d.lead.summary], ['Live Lead 2', 'referral', 'b', emp.id, null]);
  assert.deepEqual(d.activities.map(a => a.kind).reverse(), ['created', 'updated', 'stage_changed', 'assigned', 'note', 'task_created', 'task_completed']);
  assert.deepEqual([d.tasks[0].status, d.tasks[0].outcome, d.tasks[0].ownerId], ['done', 'Confirmed for Friday', emp.id]);

  // domain events landed in the outbox in the same transaction; owner can read them, employee cannot
  const ev = (await owner.client.from('domain_events').select('event_name, actor_id, aggregate_id').eq('organization_id', orgA).order('created_at')).data;
  const names = ev.filter(e => e.aggregate_id === id || e.aggregate_id === t.id).map(e => e.event_name);
  for (const n of ['lead.created', 'lead.updated', 'lead.stage_changed', 'lead.assigned', 'lead.note_added', 'task.created', 'task.completed']) assert.ok(names.includes(n), n);
  assert.equal((await emp.client.from('domain_events').select('id')).data.length, 0);
  assert.equal(ev.find(e => e.event_name === 'task.completed').actor_id, emp.id);
});

test('list: search, filters and pagination', opt, async () => {
  for (let i = 0; i < PAGE_SIZE + 2; i++) ok(await crm.createLead(O, { fullName: `Bulk Person ${String(i).padStart(2, '0')}`, phone: `+9190000${String(i).padStart(5, '0')}`, stage: i % 2 ? 'b' : 'a' }));
  const p1 = ok(await crm.listLeads(O, parseListParams({ q: 'Bulk Person' }, STAGES)));
  assert.equal(p1.rows.length, PAGE_SIZE); assert.equal(p1.total, PAGE_SIZE + 2); assert.equal(p1.pageCount, 2);
  const p2 = ok(await crm.listLeads(O, parseListParams({ q: 'Bulk Person', page: '2' }, STAGES)));
  assert.equal(p2.rows.length, 2);
  assert.equal(new Set([...p1.rows, ...p2.rows].map(r => r.id)).size, PAGE_SIZE + 2, 'pages do not overlap');
  assert.equal(ok(await crm.listLeads(O, parseListParams({ q: '9000000003' }, STAGES))).total, 1, 'phone search');
  assert.equal(ok(await crm.listLeads(O, parseListParams({ q: 'live@example.com' }, STAGES))).total, 2, 'email search: both leads of the shared contact match (the lifecycle test created a second lead on the same phone)');
  assert.equal(ok(await crm.listLeads(O, parseListParams({ q: 'Bulk Person', stage: 'b' }, STAGES))).rows.every(r => r.stage === 'b'), true);
  assert.equal(ok(await crm.listLeads(O, parseListParams({ assignee: emp.id }, STAGES))).rows.every(r => r.assignedTo === emp.id), true);
  assert.equal(ok(await crm.listLeads(O, parseListParams({ q: 'x,full_name.eq.y)(' }, STAGES))).total, 0, 'filter-syntax in search is inert');
  assert.ok(ok(await crm.stageCounts(O)).a > 0);
});

test('roles: employees see own + unassigned only, cannot reassign others; managers see everything', opt, async () => {
  const mine = ok(await crm.createLead(E, { fullName: 'Emp Own', phone: '+919111100001', assignedTo: emp.id })).id;
  const theirs = ok(await crm.createLead(M, { fullName: 'Emp2 Own', phone: '+919111100002', assignedTo: emp2.id })).id;
  const free = ok(await crm.createLead(M, { fullName: 'Nobody Yet', phone: '+919111100003' })).id;
  const seen = async c => new Set(ok(await crm.listLeads(c, parseListParams({ q: '9111100' }, STAGES))).rows.map(r => r.id));
  const e = await seen(E); assert.ok(e.has(mine) && e.has(free) && !e.has(theirs));
  const m = await seen(M); assert.ok(m.has(mine) && m.has(theirs) && m.has(free));
  assert.equal((await crm.getLead(E, theirs)).ok, false);
  assert.equal((await crm.addNote(E, theirs, 'snoop')).ok, false);
  assert.equal((await crm.assignLead(E, free, emp2.id)).ok, false);
  assert.equal((await crm.createLead(E, { fullName: 'Steal', assignedTo: emp2.id })).ok, false);
  ok(await crm.assignLead(E, free, emp.id)); // claiming for yourself is allowed
  assert.equal((await crm.assignLead(E, free, null)).ok, false);
});

test('tenant isolation: org B sees nothing of org A, and cannot act on it even by passing A\'s ids', opt, async () => {
  const id = ok(await crm.createLead(O, { fullName: 'A Private', phone: '+919222200001' })).id;
  const task = ok(await crm.createTask(O, { leadId: id, title: 'private task', dueDate: due(1) })).id;
  for (const t of ['leads', 'contacts', 'lead_activities', 'tasks', 'domain_events', 'crm_lead_list'])
    assert.deepEqual((await other.client.from(t).select('id').eq('organization_id', orgA)).data, [], `${t} hidden from B`);
  assert.equal(ok(await crm.listLeads(X, parseListParams({}, STAGES))).total, 0);
  assert.equal((await crm.getLead(X, id)).ok, false);
  assert.equal((await crm.addNote(X, id, 'x')).ok, false);
  assert.equal((await crm.setStage(X, id, 'b')).ok, false);
  assert.equal((await crm.assignLead(X, id, other.id)).ok, false);
  assert.equal((await crm.completeTask(X, task, 'x')).ok, false);
  // spoofed organization id: B's client claiming to be in org A
  const spoof = ctx(other, orgA, 'owner');
  assert.equal((await crm.createLead(spoof, { fullName: 'Intruder' })).ok, false);
  assert.equal((await crm.addMember(spoof, owner.email, 'admin')).ok, false);
  assert.equal(ok(await crm.listLeads(spoof, parseListParams({}, STAGES))).total, 0);
  assert.equal((await crm.listMembers(spoof)).ok, false);
  assert.equal((await crm.createLead(O, { fullName: 'x', assignedTo: other.id })).ok, false, 'cannot assign to a user of another org');
});

test('clients cannot write CRM tables directly (all writes go through the reviewed functions)', opt, async () => {
  const id = ok(await crm.createLead(O, { fullName: 'Direct', phone: '+919333300001' })).id;
  const tries = [
    owner.client.from('leads').update({ stage: 'b' }).eq('id', id), owner.client.from('leads').delete().eq('id', id),
    owner.client.from('contacts').update({ full_name: 'x' }).eq('organization_id', orgA),
    owner.client.from('lead_activities').insert({ organization_id: orgA, lead_id: id, kind: 'note', body: 'forged' }),
    owner.client.from('tasks').update({ status: 'done' }).eq('organization_id', orgA),
    owner.client.from('domain_events').insert({ organization_id: orgA, event_name: 'lead.created', aggregate_type: 'lead', aggregate_id: id }),
    owner.client.from('organization_members').update({ role: 'owner' }).eq('user_id', emp.id),
  ];
  for (const r of await Promise.all(tries)) assert.ok(r.error || r.count === 0, 'must be rejected');
  assert.equal(ok(await crm.getLead(O, id)).lead.stage, 'a');
});
