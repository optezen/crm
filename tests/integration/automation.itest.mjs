// LIVE Supabase (local project by default): the automation engine with REAL concurrent workers (parallel automation_tick calls over PostgREST
// with the service-role key, as the Fly.io worker does) and real RLS. Not run by `npm test`; see docs/AUTOMATION.md.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, admin, newUser, createOrg, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
after(cleanup);
let owner, e1, e2, stranger, org;
const RR = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };
const ticks = n => Promise.all(Array.from({ length: n }, () => admin().rpc('automation_tick', { p_dispatch: 50, p_runs: 50 })));
const newLead = (name, phone) => owner.client.rpc('crm_create_lead', { p_org: org, p_full_name: name, p_phone: phone, p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null });

before(async () => {
  if (guard) return;
  [owner, e1, e2, stranger] = await Promise.all(['own', 'e1', 'e2', 'str'].map(newUser));
  org = await createOrg(owner, 'Automation Live Org');
  for (const e of [e1, e2]) assert.ifError((await owner.client.rpc('crm_add_member', { p_org: org, p_email: e.email, p_role: 'employee' })).error);
});

test('lead.created -> round robin -> follow-up task; parallel workers neither duplicate nor skew the rotation', opt, async () => {
  const wf = await owner.client.rpc('automation_save_draft', { p_org: org, p_workflow: null, p_name: 'Live RR', p_definition: RR }); assert.ifError(wf.error);
  assert.ifError((await owner.client.rpc('automation_publish', { p_org: org, p_workflow: wf.data, p_enable: true })).error);
  for (let i = 0; i < 6; i++) assert.ifError((await newLead(`Live Lead ${i}`, `99900001${i}0`)).error);
  for (const r of await ticks(6)) assert.ifError(r.error); // six workers at once
  const runs = (await owner.client.from('automation_runs').select('id, status').eq('workflow_id', wf.data)).data;
  assert.equal(runs.length, 6); assert.ok(runs.every(r => r.status === 'succeeded'), JSON.stringify(runs));
  const leads = (await owner.client.from('leads').select('assigned_to').eq('organization_id', org)).data;
  const count = u => leads.filter(l => l.assigned_to === u.id).length;
  assert.deepEqual([count(e1), count(e2)], [3, 3], 'the cursor row lock makes concurrent assignment strictly alternate');
  assert.equal((await owner.client.from('tasks').select('id').eq('organization_id', org)).data.length, 6, 'one task per lead');
  await ticks(3); assert.equal((await owner.client.from('tasks').select('id').eq('organization_id', org)).data.length, 6, 'idempotent');
});

test('worker entry points and automation tables are not reachable by signed-in users; other organizations see nothing', opt, async () => {
  assert.ok((await owner.client.rpc('automation_tick')).error, 'authenticated users cannot run the worker');
  assert.ok((await owner.client.rpc('automation_dispatch', { p_limit: 5 })).error);
  assert.deepEqual((await stranger.client.from('automation_runs').select('id').eq('organization_id', org)).data, []);
  assert.deepEqual((await stranger.client.from('automation_workflows').select('id').eq('organization_id', org)).data, []);
  assert.ok((await owner.client.from('automation_runs').update({ status: 'succeeded' }).eq('organization_id', org)).error, 'no client writes to the queue');
  assert.ok((await stranger.client.rpc('automation_save_draft', { p_org: org, p_workflow: null, p_name: 'x', p_definition: RR })).error);
  assert.equal((await e1.client.from('automation_workflows').select('id').eq('organization_id', org)).data.length, 0, 'employees cannot read workflows');
});
