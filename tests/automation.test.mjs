// Automation Engine SQL tests: real PostgreSQL (PGlite) running the real migrations 0001-0007. NOT Supabase: auth.uid() and default grants are a small shim.
// Concurrency note: PGlite has ONE connection, so truly parallel workers cannot be simulated here. The round-robin cursor is serialized with a row
// lock (FOR UPDATE) and event/run claims use SKIP LOCKED; tests/integration/automation.itest.mjs fires parallel ticks against a live project.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { fieldSlug, slug } from '../src/lib/workspace/schema.ts';
import { validateAutomation, describeAutomation } from '../src/lib/automation/validate.ts';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [OWN2, EMP, EMP2, MGR, ADM] = ['b2', 'c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const F = (label, kind = 'text', extra = {}) => ({ key: fieldSlug(label), label, kind, ...extra });
const vehicles = () => ({ module: { key: 'vehicles', label: 'Vehicles', status: 'active' }, object: { key: 'vehicles', label: 'Vehicles', fields: [F('Registration'), F('Step', 'number'), F('Status', 'choice', { options: ['Available', 'Sold', 'In repair'] })] } });
const def = (...mods) => ({ schemaVersion: 1, businessName: 'X', modules: [...CORE, ...mods.map(m => m.module)], objects: mods.map(m => m.object), pipeline: { stages: ['New', 'Won'] } });

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const rpc = (u, fn, ...args) => as(u, `select public.${fn}(${args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' && args[i] !== null ? '::jsonb' : ''}`).join(',')}) r`, args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a))).then(r => r.rows[0].r);
const fails = (p, code, msg) => assert.rejects(p, e => (!code || e.code === code) && (!msg || msg.test(e.message)));
const q = async (sql, p) => (await db.query(sql, p)).rows; // superuser: inspection only
async function worker(sql, params = []) { await db.exec('set role service_role'); try { return await db.query(sql, params); } finally { await db.exec('reset role'); } }
const tick = async () => (await worker('select public.automation_tick() r')).rows[0].r;
const drain = async (n = 12) => { for (let i = 0; i < n; i++) { const r = await tick(); if (!r.dispatched && !Object.keys(r.runs).length) return; } };
const due = org => db.exec(`update public.automation_runs set next_attempt_at = now() - interval '1 second' where organization_id = '${org}' and status in ('queued','waiting','retrying')`);

let seq = 30;
async function fresh() {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test') on conflict do nothing`);
  const org = await rpc(owner, 'create_workspace', `Auto ${seq}`, null, null, def()).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await rpc(owner, 'crm_add_member', org, e, r);
  return { org, owner };
}
const publish = async (u, org, name, d, enable = true) => { const wf = await rpc(u, 'automation_save_draft', org, null, name, d); await rpc(u, 'automation_publish', org, wf, enable); return wf; };
const lead = (u, org, name = 'Priya Shah', phone = null, source = 'website') => rpc(u, 'crm_create_lead', org, name, phone, null, source, null, null, null);
const runs = (org, wf) => q(`select * from public.automation_runs where organization_id = $1 ${wf ? 'and workflow_id = $2' : ''} order by created_at, id`, wf ? [org, wf] : [org]);
const RR_TASK = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}} within a day', due_in_days: 2, owner: 'lead_assignee' }] };

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${OWN2}','own2@x.test'),('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
});

test('DELIVERABLE: lead.created -> round-robin assignee -> follow-up task with a configurable deadline', async () => {
  const { org, owner } = await fresh();
  const wf = await publish(owner, org, 'New lead follow-up', RR_TASK);
  const l1 = await lead(owner, org, 'Priya Shah');
  assert.deepEqual((await q('select count(*)::int n from public.tasks where organization_id=$1', [org]))[0], { n: 0 }, 'nothing happens until the worker runs');
  const r = await tick();
  assert.equal(r.runs.succeeded, 1);
  const [l] = await q('select assigned_to from public.leads where id=$1', [l1]);
  assert.equal(l.assigned_to, EMP, 'first eligible employee');
  const [t] = await q('select *, due_date = current_date + 2 as due_ok from public.tasks where lead_id=$1', [l1]);
  assert.equal(t.owner_id, EMP); assert.equal(t.title, 'Call Priya Shah within a day'); assert.equal(t.due_ok, true); assert.equal(t.status, 'open'); assert.equal(t.created_by, owner);
  // history + audit trail + the events the engine emitted
  const steps = await q('select action_type, status from public.automation_steps order by step_index');
  assert.deepEqual(steps.slice(-2), [{ action_type: 'assign_round_robin', status: 'succeeded' }, { action_type: 'create_task', status: 'succeeded' }]);
  const acts = await q(`select kind, meta from public.lead_activities where lead_id=$1 and kind in ('assigned','task_created') order by created_at, id`, [l1]);
  assert.ok(acts.every(a => a.meta.automation === true));
  const evs = await q(`select event_name, payload->'automation'->>'depth' d from public.domain_events where organization_id=$1 and event_name in ('lead.assigned','task.created')`, [org]);
  assert.deepEqual(evs.map(e => e.event_name).sort(), ['lead.assigned', 'task.created']); assert.ok(evs.every(e => e.d === '0'));
  // the employee sees their own task through the normal RLS path
  assert.equal((await rows(EMP, 'select * from public.tasks where lead_id=$1', [l1])).length, 1);
  // next leads rotate EMP2, EMP, EMP2
  const seen = [];
  for (let i = 0; i < 3; i++) { const x = await lead(owner, org, `Lead ${i}`); await drain(); seen.push((await q('select assigned_to from public.leads where id=$1', [x]))[0].assigned_to); }
  assert.deepEqual(seen, [EMP2, EMP, EMP2]);
  assert.equal((await runs(org, wf)).filter(x => x.status === 'succeeded').length, 4);
});

test('trigger matching: event name, module filter, enabled state, and events from before the workflow was enabled', async () => {
  const { org, owner } = await fresh();
  await rpc(owner, 'save_workspace_draft', org, def(vehicles())); await rpc(owner, 'publish_workspace_config', org);
  const onLead = await publish(owner, org, 'On lead', { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Lead!' }] });
  const onVeh = await publish(owner, org, 'On vehicles', { trigger: { event: 'record.created', object: 'vehicles' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Vehicle!' }] });
  const onTask = await publish(owner, org, 'On task', { trigger: { event: 'task.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Task!' }] });
  const l = await lead(owner, org); await drain();
  assert.equal((await runs(org, onLead)).length, 1); assert.equal((await runs(org, onVeh)).length, 0); assert.equal((await runs(org, onTask)).length, 0);
  await rpc(owner, 'record_create', org, 'vehicles', { registration: 'AB1' }); await drain();
  assert.equal((await runs(org, onVeh)).length, 1);
  await rpc(owner, 'crm_create_task', org, l, 'Call', owner, new Date().toISOString().slice(0, 10)); await drain();
  assert.equal((await runs(org, onTask)).length, 1);
  // disabled workflows do not run, and events created while disabled never run later
  await rpc(owner, 'automation_set_enabled', org, onLead, false);
  await lead(owner, org, 'While disabled', '9990000111'); await drain();
  await rpc(owner, 'automation_set_enabled', org, onLead, true); await drain();
  assert.equal((await runs(org, onLead)).length, 1, 'no run for the lead created while disabled');
  // an event created before the enable moment but dispatched after it does not run either
  await rpc(owner, 'automation_set_enabled', org, onLead, false);
  await lead(owner, org, 'Created disabled, not yet dispatched', '9990000222');
  await rpc(owner, 'automation_set_enabled', org, onLead, true); await drain();
  assert.equal((await runs(org, onLead)).length, 1);
  await lead(owner, org, 'After enable', '9990000333'); await drain();
  assert.equal((await runs(org, onLead)).length, 2);
});

test('condition evaluation: every operator, AND/OR, date comparisons', async () => {
  const ev = (field, op, value) => q(`select public.automation_cond($1::jsonb, $2::jsonb) r`, [JSON.stringify(value === undefined ? { field, op } : { field, op, value }), JSON.stringify(CTX)]).then(r => r[0].r);
  const CTX = { lead: { source: 'website', summary: 'Wants 3 Chairs', phone: '', full_name: 'Priya Shah', created_at: '2026-03-05T10:00:00Z' }, record: { step: 5, paid: true, due: '2026-12-31', empty: null } };
  const T = [['lead.source', 'eq', 'website'], ['lead.source', 'neq', 'referral'], ['lead.summary', 'contains', 'chairs'], ['lead.phone', 'empty'], ['lead.full_name', 'not_empty'], ['record.step', 'gt', 4], ['record.step', 'lt', 6],
    ['record.step', 'eq', 5], ['record.step', 'eq', '5.0'], ['record.paid', 'eq', true], ['record.due', 'after', '2026-01-01'], ['record.due', 'before', '2027-01-01'], ['lead.created_at', 'before', '2026-03-06'], ['record.empty', 'empty'], ['record.missing', 'empty'], ['record.due', 'after', 'today']];
  const want = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
  for (const [i, t] of T.entries()) assert.equal(await ev(...t), want[i], JSON.stringify(t));
  for (const t of [['lead.source', 'eq', 'referral'], ['lead.source', 'neq', 'website'], ['lead.phone', 'not_empty'], ['record.step', 'gt', 5], ['record.step', 'lt', 5], ['lead.summary', 'gt', 1], ['lead.full_name', 'before', '2026-01-01'], ['record.due', 'before', 'today'], ['lead.nope', 'eq', 'x']])
    assert.equal(await ev(...t), false, JSON.stringify(t));
  const m = (op, ...cs) => q('select public.automation_eval($1::jsonb, $2::jsonb) r', [JSON.stringify({ op, conditions: cs }), JSON.stringify(CTX)]).then(r => r[0].r);
  const yes = { field: 'lead.source', op: 'eq', value: 'website' }, no = { field: 'lead.source', op: 'eq', value: 'x' };
  assert.deepEqual([await m('and', yes, yes), await m('and', yes, no), await m('or', no, yes), await m('or', no, no), await m('and')], [true, false, true, false, true]);
  // end to end: only the matching lead gets the task
  const { org, owner } = await fresh();
  const wf = await publish(owner, org, 'Website only', { trigger: { event: 'lead.created' }, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }, { field: 'lead.phone', op: 'not_empty' }] }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'hot' }] });
  await lead(owner, org, 'A', '9990000101', 'website'); await lead(owner, org, 'B', '9990000102', 'referral'); await lead(owner, org, 'C', null, 'website'); await drain();
  assert.equal((await runs(org, wf)).length, 1);
});

test('round robin: persisted cursor per workflow, wraps, skips inactive members, survives removed members, refuses when nobody is eligible', async () => {
  const { org, owner } = await fresh();
  const pick = () => rpc(owner, 'crm_create_lead', org, 'L' + Math.random(), null, null, 'other', null, null, null).then(async x => { await drain(); return (await q('select assigned_to from public.leads where id=$1', [x]))[0].assigned_to; });
  const a = await publish(owner, org, 'RR A', { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin', roles: ['employee', 'manager'] }] });
  assert.deepEqual([await pick(), await pick(), await pick(), await pick()], [EMP, EMP2, MGR, EMP], 'employees and the manager, wrapping around');
  assert.equal((await q('select last_user_id from public.automation_rotation where workflow_id=$1', [a]))[0].last_user_id, EMP, 'cursor persisted in the database');
  // inactive members are skipped; deactivation is owner/admin only and never applies to owners
  await rpc(owner, 'set_member_active', org, EMP2, false);
  assert.deepEqual([await pick(), await pick(), await pick()], [MGR, EMP, MGR]);
  await fails(rpc(EMP, 'set_member_active', org, MGR, false), '42501'); await fails(rpc(owner, 'set_member_active', org, owner, false), '42501');
  // a removed member simply stops being a candidate, even if the cursor still points at them
  await rpc(owner, 'set_member_active', org, EMP2, true);
  await db.exec(`update public.automation_rotation set last_user_id = '${EMP2}' where workflow_id = '${a}'`);
  await db.exec(`update public.leads set assigned_to = null where organization_id='${org}' and assigned_to='${EMP2}'; delete from public.tasks where organization_id='${org}' and owner_id='${EMP2}';
    delete from public.organization_members where organization_id='${org}' and user_id='${EMP2}'`);
  assert.deepEqual([await pick(), await pick()], [MGR, EMP]);
  // a second workflow has its own independent cursor
  const b = await publish(owner, org, 'RR B', { trigger: { event: 'lead.assigned' }, match: { conditions: [{ field: 'lead.summary', op: 'contains', value: 'never' }] }, actions: [{ type: 'assign_round_robin' }] });
  assert.equal((await q('select count(*)::int n from public.automation_rotation where workflow_id=$1', [b]))[0].n, 0);
  // already-assigned leads are left alone by default
  const assigned = await rpc(owner, 'crm_create_lead', org, 'Pre assigned', null, null, 'other', null, null, ADM);
  await drain(); assert.equal((await q('select assigned_to from public.leads where id=$1', [assigned]))[0].assigned_to, ADM);
  // nobody eligible -> permanent failure, visible in the log
  for (const u of [EMP, MGR]) await rpc(owner, 'set_member_active', org, u, false);
  const x = await rpc(owner, 'crm_create_lead', org, 'Nobody', null, null, 'other', null, null, null); await drain();
  const [run] = (await q(`select * from public.automation_runs where context->'lead'->>'id' = $1 and workflow_id = $2`, [x, a]));
  assert.equal(run.status, 'dead'); assert.match(run.last_error, /No active team member is eligible/);
});

test('idempotency: re-dispatching an event, re-executing a run and retrying create nothing twice', async () => {
  const { org, owner } = await fresh();
  const wf = await publish(owner, org, 'Once', RR_TASK);
  // a second workflow wanting the same open task for the same person (triggered by the first one's assignment) does not duplicate it
  await publish(owner, org, 'Dup guard', { trigger: { event: 'lead.assigned' }, actions: [{ type: 'create_task', title: 'CALL PRIYA SHAH WITHIN A DAY', due_in_days: 1, owner: EMP }] });
  const l = await lead(owner, org); await drain();
  const count = () => q('select (select count(*)::int from public.tasks where lead_id=$1) tasks, (select count(*)::int from public.automation_runs where workflow_id=$2) runs', [l, wf]).then(r => r[0]);
  assert.deepEqual(await count(), { tasks: 1, runs: 1 });
  await db.exec(`update public.domain_events set processed_at = null where organization_id='${org}'`); // simulate the same events being delivered again
  await drain(); assert.deepEqual(await count(), { tasks: 1, runs: 1 }, 'unique (workflow, event) absorbs redelivery');
  const [r] = await runs(org, wf); assert.equal((await worker('select public.automation_execute($1) r', [r.id])).rows[0].r, 'succeeded');
  assert.deepEqual(await count(), { tasks: 1, runs: 1 });
  await drain();
  assert.equal((await q('select count(*)::int n from public.tasks where lead_id=$1', [l]))[0].n, 1);
  assert.ok((await q(`select result from public.automation_steps where result->>'skipped' = 'duplicate_open_task'`)).length >= 1);
});

test('delayed actions are rows, not timers: they wait, survive "restarts", resume when due, and stop when the workflow is disabled', async () => {
  const { org, owner } = await fresh();
  const wf = await publish(owner, org, 'Delayed', { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'wait', minutes: 60 }, { type: 'create_task', title: 'Check in with {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] });
  const l = await lead(owner, org, 'Waiter'); await drain();
  let [r] = await runs(org, wf);
  assert.equal(r.status, 'waiting'); assert.equal(r.step_index, 2);
  assert.ok(new Date(r.next_attempt_at) > new Date(Date.now() + 59 * 60e3), 'scheduled ~60 minutes ahead');
  assert.equal((await q('select count(*)::int n from public.tasks where lead_id=$1', [l]))[0].n, 0);
  await drain(); assert.equal((await runs(org, wf))[0].status, 'waiting', 'not due: later ticks (any worker, any restart) leave it alone');
  await due(org); await drain();
  [r] = await runs(org, wf); assert.equal(r.status, 'succeeded');
  const t = await q('select * from public.tasks where lead_id=$1', [l]); assert.equal(t.length, 1); assert.equal(t[0].title, 'Check in with Waiter');
  // wait until a date field: a past date continues immediately
  const w2 = await publish(owner, org, 'Wait for field', { trigger: { event: 'task.created' }, actions: [{ type: 'wait', until_field: 'task.due_date' }, { type: 'notify', recipient: 'task_owner', title: 'Task due' }] });
  await rpc(owner, 'crm_create_task', org, l, 'Future', EMP, new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)); await drain();
  assert.equal((await runs(org, w2))[0].status, 'waiting');
  // disabling cancels pending delayed work; finished history stays
  await rpc(owner, 'automation_set_enabled', org, w2, false);
  assert.equal((await runs(org, w2))[0].status, 'cancelled');
  assert.equal((await runs(org, wf))[0].status, 'succeeded');
  await due(org); await drain(); assert.equal((await q('select count(*)::int n from public.notifications where organization_id=$1 and category=\'automation\'', [org]))[0].n, 0);
});

test('retries: transient failures back off and eventually succeed; permanent failures and exhausted retries dead-letter and can be requeued', async () => {
  const { org, owner } = await fresh();
  await db.exec(`create table if not exists public.fail_ctl (on_ boolean not null); delete from public.fail_ctl; insert into public.fail_ctl values (true);
    create or replace function public.boom() returns trigger language plpgsql as $$ begin if (select on_ from public.fail_ctl) then raise exception 'database busy' using errcode = '55P03'; end if; return new; end $$;
    drop trigger if exists boom on public.tasks; create trigger boom before insert on public.tasks for each row execute function public.boom();`);
  try {
    const wf = await publish(owner, org, 'Flaky', RR_TASK);
    const l = await lead(owner, org); await drain();
    let [r] = await runs(org, wf);
    assert.equal(r.status, 'retrying'); assert.equal(r.attempts, 1); assert.match(r.last_error, /database busy/);
    assert.equal(r.step_index, 0 + 1, 'the assignment step is kept; only the failed step is retried');
    const wait1 = new Date(r.next_attempt_at) - Date.now(); assert.ok(wait1 > 0 && wait1 <= 61e3);
    await drain(); assert.equal((await runs(org, wf))[0].attempts, 1, 'backoff: not retried before it is due');
    await due(org); await drain(); [r] = await runs(org, wf);
    assert.equal(r.attempts, 2); assert.ok(new Date(r.next_attempt_at) - Date.now() > 61e3, 'backoff grows');
    await db.exec('update public.fail_ctl set on_ = false'); await due(org); await drain(); [r] = await runs(org, wf);
    assert.equal(r.status, 'succeeded'); assert.equal((await q('select count(*)::int n from public.tasks where lead_id=$1', [l]))[0].n, 1);
    const steps = await q('select step_index, status, attempts from public.automation_steps where run_id=$1 order by step_index', [r.id]);
    assert.deepEqual(steps.map(s => s.status), ['succeeded', 'succeeded']); assert.equal(steps[1].attempts, 3);
    // exhausted retries -> dead letter after max_attempts (5)
    await db.exec('update public.fail_ctl set on_ = true');
    await lead(owner, org, 'Doomed', '9990000555'); await drain();
    for (let i = 0; i < 6; i++) { await due(org); await drain(); }
    const dead = (await runs(org, wf)).find(x => x.status === 'dead'); assert.ok(dead); assert.equal(dead.attempts, 5);
    // requeue: only dead runs, owners/admins only, and the workflow must be enabled
    await db.exec('update public.fail_ctl set on_ = false');
    await fails(rpc(EMP, 'automation_requeue_run', org, dead.id), '42501');
    await rpc(owner, 'automation_requeue_run', org, dead.id); await drain();
    assert.equal((await runs(org, wf)).find(x => x.id === dead.id).status, 'succeeded');
    await fails(rpc(owner, 'automation_requeue_run', org, dead.id), '22023');
  } finally { await db.exec('drop trigger if exists boom on public.tasks'); }
  // permanent failure: no retries
  const o2 = await fresh();
  const w2 = await publish(o2.owner, o2.org, 'Bad owner', { trigger: { event: 'lead.created' }, actions: [{ type: 'create_task', title: 'x', due_in_days: 1, owner: 'lead_assignee' }] });
  await lead(o2.owner, o2.org); await drain();
  const [p] = await runs(o2.org, w2); assert.equal(p.status, 'dead'); assert.equal(p.attempts, 1); assert.match(p.last_error, /no assignee/);
});

test('infinite-loop prevention: self-triggering and ping-pong chains are skipped, and chains are depth-limited', async () => {
  const { org, owner } = await fresh();
  await rpc(owner, 'save_workspace_draft', org, def(vehicles())); await rpc(owner, 'publish_workspace_config', org);
  // 1. self loop: an update that triggers itself
  const self = await publish(owner, org, 'Self', { trigger: { event: 'record.updated', object: 'vehicles' }, actions: [{ type: 'update_record', field: 'status', value: 'Sold' }] });
  const v = await rpc(owner, 'record_create', org, 'vehicles', { registration: 'AB1', status: 'Available' });
  await rpc(owner, 'record_update', org, v, { registration: 'AB2' }); await drain();
  const rs = await runs(org, self);
  assert.deepEqual(rs.map(r => r.status), ['succeeded', 'skipped']); assert.match(rs[1].last_error, /Loop prevented/);
  assert.equal((await q('select data->>\'status\' s from public.records where id=$1', [v]))[0].s, 'Sold');
  await rpc(owner, 'automation_set_enabled', org, self, false);
  // 2. chain of five workflows, each triggering the next: depth limit 3 stops it
  const w = [];
  for (let i = 1; i <= 5; i++) w.push(await publish(owner, org, `Step ${i}`, { trigger: { event: 'record.updated', object: 'vehicles' }, match: { conditions: [{ field: 'record.step', op: 'eq', value: i }] }, actions: [{ type: 'update_record', field: 'step', value: i + 1 }] }));
  const v2 = await rpc(owner, 'record_create', org, 'vehicles', { registration: 'CH1', step: 0 });
  await rpc(owner, 'record_update', org, v2, { step: 1 }); await drain(20);
  const all = (await Promise.all(w.map(x => runs(org, x)))).flat();
  assert.deepEqual(all.map(r => r.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'skipped']);
  assert.match(all[4].last_error, /limited to 3 levels/);
  assert.equal((await q('select (data->>\'step\')::int s from public.records where id=$1', [v2]))[0].s, 5);
});

test('actions: update record (validated against the module), update task status, notify, external request without a provider', async () => {
  const { org, owner } = await fresh();
  await rpc(owner, 'save_workspace_draft', org, def(vehicles())); await rpc(owner, 'publish_workspace_config', org);
  // update_record goes through the same field validation as the UI: a value outside the dropdown is rejected, hidden fields cannot be written
  const good = await publish(owner, org, 'New vehicles are available', { trigger: { event: 'record.created', object: 'vehicles' }, match: { conditions: [{ field: 'record.status', op: 'empty' }] }, actions: [{ type: 'update_record', field: 'status', value: 'Available' }] });
  const v = await rpc(EMP, 'record_create', org, 'vehicles', { registration: 'ZZ9' }); await drain();
  assert.equal((await q('select data from public.records where id=$1', [v]))[0].data.status, 'Available');
  assert.equal((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and payload->>'automation_run_id' is not null`, [org]))[0].n, 1);
  await rpc(owner, 'automation_set_enabled', org, good, false);
  const badVal = await publish(owner, org, 'Bad value', { trigger: { event: 'record.created', object: 'vehicles' }, actions: [{ type: 'update_record', field: 'status', value: 'Teleported' }] });
  await rpc(EMP, 'record_create', org, 'vehicles', { registration: 'ZZ10' }); await drain();
  const [br] = await runs(org, badVal); assert.equal(br.status, 'dead'); assert.equal(br.attempts, 1);
  // publishing refuses unknown modules and unknown / hidden fields
  const bad = (d) => rpc(owner, 'automation_save_draft', org, null, 'x', d).then(w => fails(rpc(owner, 'automation_publish', org, w, true), '22023'));
  await bad({ trigger: { event: 'record.created', object: 'nope' }, actions: [{ type: 'wait', minutes: 1 }] });
  await bad({ trigger: { event: 'record.created', object: 'vehicles' }, actions: [{ type: 'update_record', field: 'ghost', value: 'x' }] });
  await bad({ trigger: { event: 'record.created' }, actions: [{ type: 'update_record', field: 'status', value: 'x' }] });
  // task actions + notifications + external request
  const l = await lead(owner, org, 'Asha Rao', '98450 12345');
  await publish(owner, org, 'Auto close', { trigger: { event: 'task.created' }, match: { conditions: [{ field: 'task.title', op: 'contains', value: 'auto-close' }] },
    actions: [{ type: 'update_task_status', status: 'done', outcome: 'Closed by rule for {{lead.full_name}}' }, { type: 'notify', recipient: EMP, title: 'Closed {{task.title}}', body: 'for {{lead.full_name}}' }, { type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}, thanks!' }] });
  const t = await rpc(owner, 'crm_create_task', org, l, 'Please auto-close me', owner, new Date().toISOString().slice(0, 10)); await drain();
  const [task] = await q('select status, outcome from public.tasks where id=$1', [t]); assert.deepEqual(task, { status: 'done', outcome: 'Closed by rule for Asha Rao' });
  const mine = await rows(EMP, 'select title, body, read_at from public.notifications where category=\'automation\''); assert.deepEqual(mine.map(n => [n.title, n.body]), [['Closed Please auto-close me', 'for Asha Rao']]);
  assert.equal((await rows(EMP2, 'select 1 from public.notifications where category=\'automation\'')).length, 0, 'notifications are private to the recipient');
  assert.equal((await rows(owner, 'select 1 from public.notifications where category=\'automation\'')).length, 0);
  await rpc(EMP, 'notifications_mark_read', null); assert.ok((await rows(EMP, 'select read_at from public.notifications where category=\'automation\''))[0].read_at);
  const ir = await q('select channel, status, provider, payload from public.integration_requests where organization_id=$1', [org]);
  assert.equal(ir.length, 1); assert.deepEqual([ir[0].channel, ir[0].status, ir[0].provider, ir[0].payload.message, ir[0].payload.phone], ['whatsapp', 'requested', null, 'Hi Asha Rao, thanks!', '9845012345'.length ? ir[0].payload.phone : null]);
  assert.ok(ir[0].payload.phone, 'recipient resolved from the contact');
  // no phone -> the request is refused instead of pretending
  const l2 = await lead(owner, org, 'No Phone'); await rpc(owner, 'crm_create_task', org, l2, 'Please auto-close me', owner, new Date().toISOString().slice(0, 10)); await drain();
  assert.ok((await runs(org)).some(r => r.status === 'dead' && /no phone number/.test(r.last_error)));
  assert.equal((await q('select count(*)::int n from public.integration_requests where organization_id=$1', [org]))[0].n, 1);
});

test('organization isolation, actor permissions and worker privileges', async () => {
  const A = await fresh(), B = await fresh();
  const wa = await publish(A.owner, A.org, 'A wf', { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_lead', user_id: OWN2 }] });
  const wb = await publish(B.owner, B.org, 'B wf', RR_TASK);
  await lead(A.owner, A.org); await drain();
  assert.equal((await runs(B.org, wb)).length, 0, 'an event in org A never runs org B workflows');
  const [ra] = await runs(A.org, wa);
  assert.equal(ra.status, 'dead', 'assigning to someone outside the organization is refused'); assert.match(ra.last_error, /not an active member/);
  // reads: owners/admins of the same org only
  assert.equal((await rows(B.owner, 'select 1 from public.automation_workflows where organization_id=$1', [A.org])).length, 0);
  assert.equal((await rows(B.owner, 'select 1 from public.automation_runs where organization_id=$1', [A.org])).length, 0);
  assert.equal((await rows(EMP, 'select 1 from public.automation_workflows where organization_id=$1', [A.org])).length, 0, 'employees cannot read workflows');
  assert.equal((await rows(ADM, 'select 1 from public.automation_runs where organization_id=$1', [A.org])).length, 1, 'admins can read logs');
  // writes: no client table writes, no cross-org or low-role management
  await fails(as(A.owner, `insert into public.automation_workflows (organization_id, name, created_by) values ($1, 'x', $2)`, [A.org, A.owner]), '42501');
  await fails(as(A.owner, `update public.automation_runs set status = 'succeeded'`), '42501');
  await fails(rpc(B.owner, 'automation_save_draft', A.org, null, 'x', RR_TASK), '42501');
  await fails(rpc(B.owner, 'automation_publish', A.org, wa, true), '42501');
  await fails(rpc(B.owner, 'automation_set_enabled', B.org, wa, false), 'P0002', /not found/i);
  for (const role of [EMP, MGR]) await fails(rpc(role, 'automation_save_draft', A.org, null, 'x', RR_TASK), '42501');
  // the worker entry points are not callable by signed-in users or anon
  for (const u of [A.owner, null]) { await fails(as(u, 'select public.automation_tick()'), '42501'); await fails(as(u, 'select public.automation_dispatch(5)'), '42501'); }
  await fails(as(A.owner, `select public.automation_do(null, '{}'::jsonb, 0, null)`), '42501');
  // the run acts as its publisher: demoting them stops the automation
  const wd = await publish(ADM, A.org, 'Admin made', RR_TASK);
  await rpc(A.owner, 'crm_set_member_role', A.org, ADM, 'employee');
  await lead(A.owner, A.org, 'After demotion', '9990000777'); await drain();
  const dead = (await runs(A.org, wd))[0]; assert.equal(dead.status, 'dead'); assert.match(dead.last_error, /no longer an active owner or admin/);
});

test('draft -> publish lifecycle: immutable versions, contract-only triggers, enabling rules, disable', async () => {
  const { org, owner } = await fresh();
  const draft = { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'v1' }] };
  const wf = await rpc(owner, 'automation_save_draft', org, null, 'Lifecycle', draft);
  await fails(rpc(owner, 'automation_set_enabled', org, wf, true), '22023', /Publish/);
  assert.equal(await rpc(owner, 'automation_publish', org, wf, false), 1);
  assert.deepEqual((await q('select enabled, published_version from public.automation_workflows where id=$1', [wf]))[0], { enabled: false, published_version: 1 });
  await lead(owner, org); await drain(); assert.equal((await runs(org, wf)).length, 0, 'published but not enabled');
  await rpc(owner, 'automation_save_draft', org, wf, 'Lifecycle v2', { ...draft, actions: [{ type: 'notify', recipient: 'event_actor', title: 'v2' }] });
  assert.equal(await rpc(owner, 'automation_publish', org, wf, true), 2);
  assert.deepEqual((await q('select version, status from public.automation_workflow_versions where workflow_id=$1 order by version', [wf])), [{ version: 1, status: 'archived' }, { version: 2, status: 'published' }]);
  await fails(db.query(`update public.automation_workflow_versions set definition = '{}' where workflow_id=$1 and version=2`, [wf]), '42501', /immutable/);
  await fails(db.query(`delete from public.automation_workflow_versions where workflow_id=$1 and version=1`, [wf]), '42501');
  await fails(db.query(`update public.automation_workflow_versions set status='published' where workflow_id=$1 and version=1`, [wf]), '42501');
  await lead(owner, org, 'Live', '9990000999'); await drain();
  const [r] = await runs(org, wf); assert.equal(r.status, 'succeeded');
  assert.equal((await q('select version from public.automation_workflow_versions where id=$1', [r.version_id]))[0].version, 2, 'runs are pinned to the version that was live');
  // operations triggers are real, but an automation on them can only be PUBLISHED while the matching module is enabled (it is not in this workspace)
  for (const event of ['appointment.created', 'payment.received']) {
    const c = await rpc(owner, 'automation_save_draft', org, null, event, { trigger: { event }, actions: [{ type: 'wait', minutes: 5 }] });
    await fails(rpc(owner, 'automation_publish', org, c, true), '22023', /Enable the/);
  }
  // a draft with no published version is removed completely when discarded; limits and validation
  const d = await rpc(owner, 'automation_save_draft', org, null, 'Scrap', draft); await rpc(owner, 'automation_discard_draft', org, d);
  assert.equal((await q('select count(*)::int n from public.automation_workflows where id=$1', [d]))[0].n, 0);
  await fails(rpc(owner, 'automation_save_draft', org, null, '', draft), '22023'); await fails(rpc(owner, 'automation_save_draft', org, null, 'x', { trigger: { event: 'lead.created' }, actions: [] }), '22023');
  await rpc(owner, 'automation_set_enabled', org, wf, false);
  await lead(owner, org, 'After disable', '9990000888'); await drain(); assert.equal((await runs(org, wf)).length, 1);
  const audit = await q(`select event_name, count(*)::int n from public.audit_events where organization_id=$1 and event_name like 'automation.%' group by 1 order by 1`, [org]);
  assert.deepEqual(audit, [{ event_name: 'automation.disabled', n: 1 }, { event_name: 'automation.draft_saved', n: 5 }, { event_name: 'automation.published', n: 2 }]);
});

test('the TypeScript validator (used by the editor) and automation_validate (the real gate) agree on a corpus', async () => {
  const U = id('c3'), n = (a, b) => ({ trigger: { event: a }, actions: b });
  const wait = [{ type: 'wait', minutes: 5 }];
  const corpus = [
    RR_TASK, n('record.created', wait), { ...n('record.updated', wait), trigger: { event: 'record.updated', object: 'vehicles' } }, n('lead.created', wait), n('payment.received', wait), n('nope.created', wait), n('lead.created', []),
    { ...n('lead.created', wait), trigger: { event: 'lead.created', object: 'vehicles' } }, { ...n('lead.created', wait), extra: 1 }, n('lead.created', [{ type: 'drop_table' }]), n('lead.created', [{ type: 'wait', minutes: 0 }]),
    n('lead.created', [{ type: 'wait', minutes: 5, until_field: 'lead.created_at' }]), n('lead.created', [{ type: 'wait', until_field: 'record.x' }]), n('task.created', [{ type: 'wait', until_field: 'task.due_date' }]),
    n('lead.created', [{ type: 'create_task', title: 'T', due_in_days: 366, owner: 'lead_assignee' }]), n('lead.created', [{ type: 'create_task', title: 'T', due_in_days: 1.5, owner: 'lead_assignee' }]),
    n('lead.created', [{ type: 'create_task', title: 'T', due_in_days: 1, owner: U }]), n('lead.created', [{ type: 'create_task', title: 'T', due_in_days: 1, owner: 'anyone' }]), n('record.created', [{ type: 'create_task', title: 'T', due_in_days: 1, owner: U }]),
    n('lead.created', [{ type: 'assign_lead', user_id: U }]), n('lead.created', [{ type: 'assign_lead', user_id: 'x' }]), n('lead.created', [{ type: 'assign_round_robin', roles: ['owner'] }]), n('lead.created', [{ type: 'assign_round_robin', roles: [] }]),
    n('lead.created', [{ type: 'assign_round_robin', roles: ['manager'], only_if_unassigned: false }]), n('lead.created', [{ type: 'assign_round_robin', only_if_unassigned: 'no' }]),
    n('task.completed', [{ type: 'update_task_status', status: 'done', outcome: 'ok' }]), n('task.completed', [{ type: 'update_task_status', status: 'done' }]), n('task.completed', [{ type: 'update_task_status', status: 'open' }]), n('task.completed', [{ type: 'update_task_status', status: 'open', outcome: 'x' }]), n('lead.created', [{ type: 'update_task_status', status: 'open' }]),
    n('record.created', [{ type: 'update_record', field: 'status', value: 'x' }]), n('record.created', [{ type: 'update_record', field: 'Bad Key', value: 'x' }]), n('record.created', [{ type: 'update_record', field: 'status', value: null }]), n('lead.created', [{ type: 'update_record', field: 'status', value: 'x' }]),
    n('lead.created', [{ type: 'notify', recipient: 'lead_assignee', title: 'T' }]), n('record.created', [{ type: 'notify', recipient: 'lead_assignee', title: 'T' }]), n('lead.created', [{ type: 'notify', recipient: 'task_owner', title: 'T' }]), n('task.created', [{ type: 'notify', recipient: 'task_owner', title: 'T', body: 'b' }]), n('lead.created', [{ type: 'notify', recipient: 'event_actor', title: '' }]),
    n('lead.created', [{ type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'hi' }]), n('lead.created', [{ type: 'request_integration', channel: 'whatsapp', message: 'hi' }]), n('record.created', [{ type: 'request_integration', channel: 'webhook', message: 'hi' }]), n('lead.created', [{ type: 'request_integration', channel: 'telegram', message: 'hi' }]),
    { ...n('lead.created', wait), match: { op: 'or', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }, { field: 'lead.phone', op: 'empty' }] } }, { ...n('lead.created', wait), match: { op: 'xor', conditions: [] } },
    { ...n('lead.created', wait), match: { conditions: [{ field: 'record.x', op: 'eq', value: 1 }] } }, { ...n('record.created', wait), match: { conditions: [{ field: 'record.x', op: 'gt', value: 'abc' }] } }, { ...n('record.created', wait), match: { conditions: [{ field: 'record.d', op: 'before', value: 'tomorrow' }] } },
    { ...n('record.created', wait), match: { conditions: [{ field: 'record.d', op: 'before', value: '2026-02-30' }] } }, { ...n('record.created', wait), match: { conditions: [{ field: 'record.d', op: 'empty', value: 'x' }] } }, { ...n('record.created', wait), match: { conditions: [{ field: 'record.d', op: 'eq' }] } }, { ...n('task.created', wait), match: { conditions: [{ field: 'lead.stage', op: 'eq', value: 'New' }, { field: 'task.status', op: 'neq', value: 'done' }] } },
    [], null, 'x',
  ];
  let ok = 0;
  for (const [i, d] of corpus.entries()) {
    const sqlOk = await db.query('select public.automation_validate($1::jsonb)', [JSON.stringify(d)]).then(() => true, e => { assert.equal(e.code, '22023', `case ${i}: ${e.message}`); return false; });
    assert.equal(validateAutomation(d).ok, sqlOk, `case ${i}: ${JSON.stringify(d)}`); ok += sqlOk;
  }
  assert.ok(ok >= 15 && ok < corpus.length - 15, `corpus must mix valid and invalid (valid: ${ok}/${corpus.length})`);
});

test('preview text describes the workflow in plain language', () => {
  const lines = describeAutomation(RR_TASK);
  assert.match(lines[0], /^When a lead is created/); assert.match(lines[1], /round-robin|rotation/); assert.match(lines[2], /Call \{\{lead\.full_name\}\}.*due in 2 days/);
});
