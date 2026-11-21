// Visual Builder tests: real PostgreSQL (PGlite) with migrations 0001-0017. No provider or network is contacted.
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
import { executeTool } from '../src/lib/ai/tools.ts';
import { applyProposal } from '../src/lib/ai/proposals.ts';
import { definitionToGraph, graphToDefinition, addNode, blankAction } from '../src/lib/builder/workflowGraph.ts';
const ctxFor = (o, user, role) => ({ org: o.org, userId: user, role, conversationId: null, rpc: mkRpc(user), platformMissing: () => ({ meta: [], whatsapp: [] }), loadConfigs: async () => { const r = await mkRpc(user)('workspace_configs', {}); throw new Error('unused'); } });
const tool = async (ctx, name, args) => { const r = await executeTool(ctx, name, args); return { ...r, json: JSON.parse(r.content) }; };
const LAYOUT = { v: 1, order: ['n1', 'n2', 'n3'], pos: { n1: { x: 40, y: 120 }, n2: { x: 340, y: 120 }, n3: { x: 640, y: 120 } }, view: { x: 0, y: 0, z: 1 } };
const DEF = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };

test('layout is stored apart from the executable definition, and is validated', async () => {
  const { org, owner } = await fresh();
  const r = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: null, p_name: 'Canvas', p_definition: DEF, p_layout: LAYOUT, p_expected_token: null, p_expected_published: null }));
  assert.ok(r.id && r.token && r.token !== 'none');
  const [d] = await q(`select definition from public.automation_workflow_versions where workflow_id=$1 and status='draft'`, [r.id]);
  assert.deepEqual(d.definition, DEF); assert.ok(!JSON.stringify(d.definition).includes('"pos"'), 'no layout in the definition');
  assert.deepEqual((await q('select layout from public.automation_layouts where workflow_id=$1', [r.id]))[0].layout, LAYOUT);
  // bad layouts and bad definitions are refused with nothing stored
  for (const bad of [{ v: 1, pos: { n1: { x: 'a', y: 1 } } }, { v: 1, order: ['BAD ID'] }, { v: 1, pos: { n1: { x: 1e9, y: 1 } } }, { v: 1, view: { x: 0, y: 0, z: 99 } }, { v: 1, extra: 1 }, [1], { v: 1, order: Array.from({ length: 41 }, (_, i) => `n${i}`) }])
    await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: r.id, p_name: 'Canvas', p_definition: DEF, p_layout: bad, p_expected_token: r.token, p_expected_published: null }));
  await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: r.id, p_name: 'Canvas', p_definition: { trigger: { event: 'lead.created' }, actions: [] }, p_layout: LAYOUT, p_expected_token: r.token, p_expected_published: null }));
  assert.equal((await q('select count(*)::int n from public.automation_workflows where organization_id=$1', [org]))[0].n, 1);
});
async function bad_(p) { const r = await p; assert.ok(r.error, 'expected an error'); return r; }

test('conflicting saves are detected: stale token, publish elsewhere, and a second tab', async () => {
  const { org, owner } = await fresh();
  const a = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: null, p_name: 'Race', p_definition: DEF, p_layout: LAYOUT, p_expected_token: null, p_expected_published: null }));
  const edited = { ...DEF, actions: [...DEF.actions, { type: 'notify', recipient: 'event_actor', title: 'Done' }] };
  const second = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Race', p_definition: edited, p_layout: LAYOUT, p_expected_token: a.token, p_expected_published: null }));
  assert.notEqual(second.token, a.token);
  // the first tab still holds the old token: refused, and nothing is overwritten
  const stale = await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Race', p_definition: DEF, p_layout: LAYOUT, p_expected_token: a.token, p_expected_published: null }));
  assert.equal(stale.error.code, '22023'); assert.match(stale.error.message, /changed since you opened it/);
  assert.equal((await q(`select jsonb_array_length(definition->'actions') n from public.automation_workflow_versions where workflow_id=$1 and status='draft'`, [a.id]))[0].n, 3);
  // saving without a token is refused too (no blind overwrite); a rename changes the token
  await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Race', p_definition: DEF, p_layout: LAYOUT, p_expected_token: null, p_expected_published: null }));
  const renamed = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Renamed', p_definition: edited, p_layout: LAYOUT, p_expected_token: second.token, p_expected_published: null }));
  assert.notEqual(renamed.token, second.token);
  // publish, then an editor opened on the old published version is stale; one opened after it is fine
  await ok(call(owner, 'automation_publish', { p_org: org, p_workflow: a.id, p_enable: false }));
  assert.equal(await ok(call(owner, 'automation_draft_token', { p_org: org, p_workflow: a.id })), 'none');
  await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Renamed', p_definition: DEF, p_layout: LAYOUT, p_expected_token: renamed.token, p_expected_published: null }));
  const fresh2 = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Renamed', p_definition: DEF, p_layout: LAYOUT, p_expected_token: 'none', p_expected_published: 1 }));
  assert.ok(fresh2.token !== 'none');
  await bad_(call(owner, 'automation_save_visual', { p_org: org, p_workflow: a.id, p_name: 'Renamed', p_definition: DEF, p_layout: LAYOUT, p_expected_token: fresh2.token, p_expected_published: 0 }));
});

test('permissions and tenant isolation for visual saves and layouts', async () => {
  const A = await fresh(), B = await fresh();
  const a = await ok(call(A.owner, 'automation_save_visual', { p_org: A.org, p_workflow: null, p_name: 'Mine', p_definition: DEF, p_layout: LAYOUT, p_expected_token: null, p_expected_published: null }));
  for (const u of [EMP, MGR]) {
    assert.equal((await bad_(call(u, 'automation_save_visual', { p_org: A.org, p_workflow: null, p_name: 'x', p_definition: DEF, p_layout: LAYOUT, p_expected_token: null, p_expected_published: null }))).error.code, '42501');
    assert.equal((await bad_(call(u, 'automation_draft_token', { p_org: A.org, p_workflow: a.id }))).error.code, '42501');
    assert.deepEqual(await rows(u, 'select * from public.automation_layouts'), [], 'layouts are invisible to non-admins');
  }
  // another organization's owner cannot read, save to or probe this workflow
  assert.deepEqual(await rows(B.owner, 'select * from public.automation_layouts'), []);
  assert.equal((await bad_(call(B.owner, 'automation_save_visual', { p_org: B.org, p_workflow: a.id, p_name: 'x', p_definition: DEF, p_layout: LAYOUT, p_expected_token: a.token, p_expected_published: null }))).error.code, 'P0002');
  assert.equal((await bad_(call(B.owner, 'automation_save_visual', { p_org: A.org, p_workflow: a.id, p_name: 'x', p_definition: DEF, p_layout: LAYOUT, p_expected_token: a.token, p_expected_published: null }))).error.code, '42501');
  assert.equal(await ok(call(B.owner, 'automation_draft_token', { p_org: B.org, p_workflow: a.id })), 'none', 'a foreign id reveals nothing');
  // no direct writes to layouts
  await assert.rejects(as(A.owner, `insert into public.automation_layouts (workflow_id, organization_id, layout, updated_by) values ($1,$2,'{}',$3)`, [a.id, A.org, A.owner]));
  assert.equal((await rows(A.owner, 'select * from public.automation_layouts')).length, 1);
  // discarding the only draft removes the layout with the workflow
  await ok(call(A.owner, 'automation_discard_draft', { p_org: A.org, p_workflow: a.id }));
  assert.equal((await q('select count(*)::int n from public.automation_layouts where workflow_id=$1', [a.id]))[0].n, 0);
});

test('a canvas-built workflow, the list editor and an AI proposal produce the same definition, and the engine executes it', async () => {
  const { org, owner } = await fresh();
  const O = { org, owner }, W = ctxFor(O, owner, 'owner');
  // 1. AI proposal (tool) -> payload
  const proposed = await tool(W, 'propose_automation', { name: 'Website leads', summary: 'Assign and follow up', definition: { ...DEF, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }] } } });
  assert.equal(proposed.ok, true, proposed.content);
  const [prop] = await q(`select id, payload from public.ai_proposals where organization_id=$1`, [org]);
  const aiDef = prop.payload.definition;
  // 2. open it in the canvas model, edit visually (add a notify after the task), compile
  let { graph } = definitionToGraph(aiDef);
  assert.deepEqual(graphToDefinition(graph).definition, aiDef, 'opening an AI proposal on the canvas changes nothing');
  graph = addNode(graph, { id: 'n9', kind: 'action', action: { ...blankAction('notify'), title: 'New website lead' } }, graph.nodes.at(-1).id);
  const visual = graphToDefinition(graph); assert.ok(visual.ok);
  // 3. the same definition through the list-editor path (automation_save_draft) and the canvas path (automation_save_visual)
  const list = await ok(call(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'List', p_definition: visual.definition }));
  const vis = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: null, p_name: 'Canvas', p_definition: visual.definition, p_layout: { v: 1, order: visual.order, pos: Object.fromEntries(visual.order.map((i, k) => [i, { x: k * 300, y: 100 }])) }, p_expected_token: null, p_expected_published: null }));
  const defOf = id => q(`select definition from public.automation_workflow_versions where workflow_id=$1`, [id]).then(r => r[0].definition);
  assert.deepEqual(await defOf(list), await defOf(vis.id), 'list editor and canvas store identical executable definitions');
  // 4. the AI "approve" step on a proposal uses the same save and the canvas can then continue editing that draft
  const applied = await applyProposal({ org, rpc: mkRpc(owner), loadConfigs: async () => { throw new Error('n/a'); } }, prop.id, 'save_draft'); assert.equal(applied.ok, true, applied.error);
  const [pw] = await q(`select workflow_id from public.ai_proposals where id=$1`, [prop.id]);
  assert.deepEqual(await defOf(pw.workflow_id), aiDef);
  const tok = await ok(call(owner, 'automation_draft_token', { p_org: org, p_workflow: pw.workflow_id }));
  await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: pw.workflow_id, p_name: 'Website leads', p_definition: visual.definition, p_layout: null, p_expected_token: tok, p_expected_published: null }));
  const stalePublish = await applyProposal({ org, rpc: mkRpc(owner), loadConfigs: async () => { throw new Error('n/a'); } }, prop.id, 'publish_enable');
  assert.equal(stalePublish.ok, false); assert.match(stalePublish.error, /changed after you approved/, 'a visually edited draft cannot be published through the stale AI proposal');
  // 5. publish the visual draft through the existing engine and run it
  await ok(call(owner, 'automation_publish', { p_org: org, p_workflow: vis.id, p_enable: true }));
  const l1 = await lead(owner, org, 'Visual Lead', '+919800000001', { source: 'website' });
  await drain();
  const [done] = await q(`select status from public.automation_runs where workflow_id=$1`, [vis.id]); assert.equal(done.status, 'succeeded');
  assert.equal((await q(`select count(*)::int n from public.tasks where lead_id=$1`, [l1]))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from public.notifications where organization_id=$1 and title='New website lead'`, [org]))[0].n, 1);
  const steps = await q(`select action_type, status from public.automation_steps order by step_index`);
  assert.deepEqual(steps.map(s => s.action_type), ['assign_round_robin', 'create_task', 'notify']); assert.ok(steps.every(s => s.status === 'succeeded'));
});

test('a delay node executes as a durable wait (the engine runs it, nothing else is invented)', async () => {
  const { org, owner } = await fresh();
  let { graph } = definitionToGraph({ trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'First' }] });
  graph = addNode(graph, { id: 'n9', kind: 'delay', action: { type: 'wait', minutes: 30 } }, graph.nodes.at(-1).id);
  graph = addNode(graph, { id: 'n10', kind: 'action', action: { type: 'notify', recipient: 'event_actor', title: 'Second' } }, 'n9');
  const c = graphToDefinition(graph); assert.ok(c.ok);
  const wf = await ok(call(owner, 'automation_save_visual', { p_org: org, p_workflow: null, p_name: 'Delayed', p_definition: c.definition, p_layout: null, p_expected_token: null, p_expected_published: null }));
  await ok(call(owner, 'automation_publish', { p_org: org, p_workflow: wf.id, p_enable: true }));
  await lead(owner, org, 'Wait Lead', '+919800000002'); await drain();
  const [r] = await q(`select status, step_index, next_attempt_at > now() as later from public.automation_runs where workflow_id=$1`, [wf.id]);
  assert.deepEqual([r.status, r.later], ['waiting', true]);
  assert.equal((await q(`select count(*)::int n from public.notifications where title='Second'`))[0].n, 0, 'the step after the delay has not run');
  await q(`update public.automation_runs set next_attempt_at = now() - interval '1 minute' where workflow_id=$1`, [wf.id]); await drain();
  assert.equal((await q(`select status from public.automation_runs where workflow_id=$1`, [wf.id]))[0].status, 'succeeded');
  assert.equal((await q(`select count(*)::int n from public.notifications where title='Second'`))[0].n, 1);
});

// ---------- forms and pipeline ----------
import { validateConfig, diffConfig } from '../src/lib/workspace/schema.ts';
const publishCfg = async (owner, org, cfg) => { await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: cfg })); return call(owner, 'publish_workspace_config', { p_org: org }); };
const stageOf = id => q('select stage from public.leads where id=$1', [id]).then(r => r[0].stage);

test('form settings: description and section validate identically in TypeScript and PostgreSQL, and records survive reordering', async () => {
  const { org, owner } = await fresh(BASE);
  const fields = [{ key: 'registration', label: 'Registration', kind: 'text', required: true, description: 'As printed on the plate', section: 'Identity' }, { key: 'status', label: 'Status', kind: 'choice', options: ['Available', 'Sold'], section: 'Sale' }, { key: 'note', label: 'Note', kind: 'text' }];
  const cfg = { ...BASE, modules: [...CORE, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [{ key: 'vehicles', label: 'Vehicles', fields }] };
  assert.ok(validateConfig(cfg).ok); assert.deepEqual(validateConfig(cfg).value.objects[0].fields[0], fields[0]);
  await ok(publishCfg(owner, org, cfg));
  const rec = await ok(call(owner, 'record_create', { p_org: org, p_object: 'vehicles', p_data: { registration: 'KA01AB1234', status: 'Sold', note: 'keep me' } }));
  // bad values are rejected by both validators with the same verdict
  for (const bad of [{ description: 'x'.repeat(201) }, { description: 5 }, { section: 'y'.repeat(41) }, { section: {} }]) {
    const c = { ...cfg, objects: [{ ...cfg.objects[0], fields: [{ ...fields[0], ...bad }, ...fields.slice(1)] }] };
    assert.equal(validateConfig(c).ok, false, JSON.stringify(bad)); assert.equal((await call(owner, 'save_workspace_draft', { p_org: org, p_definition: c })).error?.code, '22023', JSON.stringify(bad));
  }
  // rearrange fields, regroup sections, edit labels/help text: keys are stable, so stored values are untouched
  const rearranged = { ...cfg, objects: [{ ...cfg.objects[0], fields: [fields[2], { ...fields[1], section: 'Identity', label: 'Sale status', description: 'Updated' }, { ...fields[0], section: undefined }] }] };
  const v = validateConfig(rearranged); assert.ok(v.ok);
  assert.ok(diffConfig(cfg, v.value).some(l => /reorder fields/.test(l)) && diffConfig(cfg, v.value).some(l => /rename field/.test(l)) && diffConfig(cfg, v.value).some(l => /section/.test(l)));
  await ok(publishCfg(owner, org, v.value));
  const [row] = await q('select data from public.records where id=$1', [rec.id ?? rec]); assert.deepEqual(row.data, { registration: 'KA01AB1234', status: 'Sold', note: 'keep me' });
  // changing a key or removing a field that holds data is still refused (the Builder cannot lose records)
  const renamedKey = { ...cfg, objects: [{ ...cfg.objects[0], fields: [{ ...fields[0], key: 'reg_no' }, ...fields.slice(1)] }] };
  assert.ok((await publishCfg(owner, org, renamedKey)).error);
  assert.deepEqual((await q('select data from public.records where id=$1', [rec.id ?? rec]))[0].data, row.data);
});

test('pipeline: colors and transition requirements are validated and enforced when a lead moves', async () => {
  const stages = ['New', 'Qualified', 'Won'];
  const cfg = { ...BASE, pipeline: { stages, stageSettings: { Qualified: { color: 'blue', requires_assignee: true }, Won: { color: 'green', requires_summary: true, requires_assignee: true } } } };
  assert.ok(validateConfig(cfg).ok);
  for (const badP of [{ stages, stageSettings: { Missing: { color: 'blue' } } }, { stages, stageSettings: { New: { color: 'pink' } } }, { stages, stageSettings: { New: { requires_assignee: 'yes' } } }, { stages, stageSettings: { New: { other: 1 } } }]) {
    const c = { ...BASE, pipeline: badP }; assert.equal(validateConfig(c).ok, false);
    const { org, owner } = await fresh(BASE); assert.equal((await call(owner, 'save_workspace_draft', { p_org: org, p_definition: c })).error?.code, '22023');
  }
  const { org, owner } = await fresh(BASE); await ok(publishCfg(owner, org, cfg));
  const free = await lead(owner, org, 'No Owner', '+919811110001'); // unassigned (admin creates)
  await bad(call(owner, 'crm_set_stage', { p_org: org, p_lead: free, p_stage: 'Qualified' }), '22023', /needs an assignee/);
  assert.equal(await stageOf(free), 'New');
  await ok(call(owner, 'crm_assign_lead', { p_org: org, p_lead: free, p_assignee: EMP }));
  await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: free, p_stage: 'Qualified' })); assert.equal(await stageOf(free), 'Qualified');
  await bad(call(owner, 'crm_set_stage', { p_org: org, p_lead: free, p_stage: 'Won' }), '22023', /needs a summary/);
  await ok(call(owner, 'crm_update_lead', { p_org: org, p_lead: free, p_full_name: 'No Owner', p_phone: '+919811110001', p_email: null, p_source: 'website', p_summary: 'Wants the premium plan' }));
  await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: free, p_stage: 'Won' })); assert.equal(await stageOf(free), 'Won');
  // invalid stage and cross-org lead ids are refused like before
  await bad(call(owner, 'crm_set_stage', { p_org: org, p_lead: free, p_stage: 'Nowhere' }), '22023');
  const other = await fresh(BASE); await bad(call(other.owner, 'crm_set_stage', { p_org: other.org, p_lead: free, p_stage: 'Qualified' }), 'P0002');
});

test('pipeline: renaming, merging and removing a stage with leads needs a migration plan, applied atomically and audited', async () => {
  const { org, owner } = await fresh(BASE); const A = await fresh(BASE);
  const l1 = await lead(owner, org, 'One', '+919811110011'), l2 = await lead(owner, org, 'Two', '+919811110012'), la = await lead(A.owner, A.org, 'Other org', '+919811110013');
  await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: l1, p_stage: 'Qualified' })); await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: l2, p_stage: 'Qualified' })); await ok(call(A.owner, 'crm_set_stage', { p_org: A.org, p_lead: la, p_stage: 'Qualified' }));
  const base = { ...BASE, pipeline: { stages: ['New', 'Vetted', 'Won'] } };
  // 1. dropping 'Qualified' without a plan: refused, nothing moves
  const noPlan = await publishCfg(owner, org, base); assert.equal(noPlan.error.code, '22023'); assert.match(noPlan.error.message, /still in the stage "Qualified"/);
  assert.equal(await stageOf(l1), 'Qualified');
  // 2. invalid plans are rejected by TS and SQL
  for (const mv of [[{ from: 'Qualified', to: 'Nowhere' }], [{ from: 'New', to: 'Vetted' }], [{ from: 'Qualified', to: 'Vetted' }, { from: 'Qualified', to: 'Won' }], [{ from: 'Qualified', to: 'Vetted', extra: 1 }]]) {
    const c = { ...base, pipeline: { ...base.pipeline, stageMoves: mv } }; assert.equal(validateConfig(c).ok, false);
    assert.equal((await call(owner, 'save_workspace_draft', { p_org: org, p_definition: c })).error?.code, '22023', JSON.stringify(mv));
  }
  // 3. a rename plan: leads move, history is written, only this organization is touched, and the plan is not kept in the published version
  const plan = { ...base, pipeline: { stages: base.pipeline.stages, stageMoves: [{ from: 'Qualified', to: 'Vetted' }] } };
  assert.ok(diffConfig(BASE, validateConfig(plan).value).some(x => /Move leads from stage "Qualified" to "Vetted"/.test(x)));
  await ok(publishCfg(owner, org, plan));
  assert.deepEqual([await stageOf(l1), await stageOf(l2), await stageOf(la)], ['Vetted', 'Vetted', 'Qualified']);
  const acts = await q(`select meta from public.lead_activities where lead_id=$1 and kind='stage_changed' order by created_at desc limit 1`, [l1]);
  assert.deepEqual([acts[0].meta.from, acts[0].meta.to, acts[0].meta.reason], ['Qualified', 'Vetted', 'pipeline_migration']);
  const aud = await q(`select payload from public.audit_events where organization_id=$1 and event_name='workspace.published' order by created_at desc limit 1`, [org]);
  assert.deepEqual(aud[0].payload.stage_moves, [{ from: 'Qualified', to: 'Vetted', leads: 2 }]);
  assert.equal((await q(`select definition #> '{pipeline,stageMoves}' as m from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org]))[0].m, null, 'stale plans cannot be re-applied');
  // 4. a merge plan (remove a stage by moving its leads into another)
  const merge = { ...BASE, pipeline: { stages: ['New', 'Won'], stageMoves: [{ from: 'Vetted', to: 'Won' }] } };
  await ok(publishCfg(owner, org, merge)); assert.deepEqual([await stageOf(l1), await stageOf(l2)], ['Won', 'Won']);
  // 5. the previous activity rows were not rewritten
  assert.ok((await q(`select count(*)::int n from public.lead_activities where lead_id=$1 and kind='stage_changed'`, [l1]))[0].n >= 3);
});

// ---------- contact privacy (phone / email) ----------
test('phone and email cannot be read straight from the contacts table by anyone signed in, whatever their role', async () => {
  const { org, owner } = await fresh(BASE);
  await lead(owner, org, 'Private Person', '+919822220001', { email: 'private@example.com' });
  for (const u of [owner, ADM, MGR, EMP]) {
    for (const sql of ['select phone from public.contacts', 'select email from public.contacts', 'select * from public.contacts', 'select c.phone from public.contacts c', `select count(*) from public.contacts where phone like '%9822%'`, `select id from public.contacts where email = 'private@example.com'`]) {
      await assert.rejects(as(u, sql), e => e.code === '42501', `${u.slice(-2)}: ${sql}`);
    }
    assert.ok((await rows(u, 'select id, full_name from public.contacts')).length >= 0, 'non-personal columns remain readable');
  }
  await assert.rejects(as(null, 'select id from public.contacts'), e => e.code === '42501');
  await assert.rejects(as(null, `select public.contact_phone('${id('99')}')`), e => e.code === '42501');
  // writes still only go through the checked functions
  await assert.rejects(as(owner, `update public.contacts set phone = '1'`), e => e.code === '42501');
  // the approved read path works for every default role that can see the lead
  for (const u of [owner, ADM, MGR]) { const [r] = await rows(u, `select phone, email, contact_hidden from public.crm_lead_list where full_name='Private Person'`); assert.deepEqual([r.phone, r.email, r.contact_hidden], ['+919822220001', 'private@example.com', false]); }
});

test('a custom role can hide contact details; they disappear from lists, search, detail and the AI assistant, but not from server automation', async () => {
  const { org, owner } = await fresh(BASE);
  const open = await lead(owner, org, 'Open Lead', '+919822220011', { email: 'open@example.com' });          // unassigned: an employee can see the lead
  const role = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'Sales no contacts', p_base: 'employee', p_permissions: { contacts: { view: false } }, p_scopes: {}, p_location_restricted: false }));
  // validation: only 'view' exists for contacts, and a role can never grant more than its base
  await bad(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'x', p_base: 'employee', p_permissions: { contacts: { edit: true } }, p_scopes: {}, p_location_restricted: false }), '22023');
  const before = (await rows(EMP, `select phone, contact_hidden from public.crm_lead_list where id=$1`, [open]))[0]; assert.deepEqual([before.phone, before.contact_hidden], ['+919822220011', false], 'default employees keep seeing details');
  await ok(call(owner, 'member_assign_role', { p_org: org, p_user: EMP, p_custom_role: role, p_base_if_cleared: 'employee' }));
  const [hid] = await rows(EMP, `select full_name, phone, email, contact_hidden from public.crm_lead_list where id=$1`, [open]);
  assert.deepEqual([hid.full_name, hid.phone, hid.email, hid.contact_hidden], ['Open Lead', null, null, true], 'name stays, details hidden');
  assert.deepEqual(await rows(EMP, `select id from public.crm_lead_list where organization_id=$1 and (phone ilike '%98222%' or email ilike '%open@%')`, [org]), [], 'no search oracle');
  // AI lookup honours it even when the model asks for contact details
  const W = ctxFor({ org, owner }, EMP, 'employee');
  const g = await tool(W, 'get_lead', { lead_id: open, include_contact: true });
  assert.ok(g.ok, g.content); assert.equal(g.json.data.phone, null); assert.equal(g.json.data.email, null); assert.equal(g.json.data.contact_details_included, false);
  // editing the lead as the restricted user cannot erase or overwrite the hidden details
  await ok(call(EMP, 'crm_update_lead', { p_org: org, p_lead: open, p_full_name: 'Open Lead', p_phone: null, p_email: null, p_source: 'website', p_summary: 'edited by restricted user' }));
  await ok(call(EMP, 'crm_update_lead', { p_org: org, p_lead: open, p_full_name: 'Open Lead', p_phone: '+919800099999', p_email: 'hacked@example.com', p_source: 'website', p_summary: 'edited again' }));
  const [kept] = await rows(owner, `select phone, email, summary from public.crm_lead_list where id=$1`, [open]); assert.deepEqual([kept.phone, kept.email, kept.summary], ['+919822220011', 'open@example.com', 'edited again']);
  // others are unaffected, and server-side automation (definer) still sees the number to message it
  assert.equal((await rows(MGR, `select phone from public.crm_lead_list where id=$1`, [open]))[0].phone, '+919822220011');
  const wf = await ok(call(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'Msg', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}' }] } }));
  await ok(call(owner, 'automation_publish', { p_org: org, p_workflow: wf, p_enable: true }));
  await lead(owner, org, 'Msg Lead', '+919822220012'); await drain();
  assert.equal((await q(`select count(*)::int n from public.integration_requests where organization_id=$1`, [org]))[0].n, 1, 'automation still reads the number server-side');
});

test('contact details follow lead visibility exactly (parity with row-level security) and never cross organizations', async () => {
  const A = await fresh(BASE), B = await fresh(BASE);
  const l1 = await lead(A.owner, A.org, 'Mine', '+919822220021', { assignee: EMP }), l2 = await lead(A.owner, A.org, 'Theirs', '+919822220022', { assignee: EMP2 }), l3 = await lead(A.owner, A.org, 'Free', '+919822220023');
  const lb = await lead(B.owner, B.org, 'Other org', '+919822220024');
  const cid = async l => (await q('select contact_id from public.leads where id=$1', [l]))[0].contact_id;
  for (const u of [A.owner, ADM, MGR, EMP, EMP2]) {
    const visible = new Set((await rows(u, 'select id from public.leads')).map(r => r.id));
    for (const l of [l1, l2, l3]) {
      const [v] = await rows(u, `select public.contact_details_visible($1) v, public.contact_phone($1) p`, [await cid(l)]);
      assert.equal(v.v, visible.has(l), `user ${u.slice(-2)} lead ${l.slice(-4)}: details visible iff the lead is visible`); assert.equal(v.p !== null, visible.has(l));
    }
    if (u === A.owner) { const [x] = await rows(u, `select public.contact_details_visible($1) v, public.contact_phone($1) p, public.contact_email($1) e`, [await cid(lb)]); assert.deepEqual([x.v, x.p, x.e], [false, null, null], 'another organization is never readable'); }
  }
  assert.deepEqual([await rows(B.owner, `select public.contact_phone($1) p`, [await cid(l1)]).then(r => r[0].p)], [null]);
});

test('exports, reports and analytics never carry phone or email', async () => {
  const { org, owner } = await fresh(BASE);
  await lead(owner, org, 'Report Person', '+919822220031', { email: 'report@example.com' });
  const cat = await ok(call(owner, 'analytics_catalog', { p_org: org }));
  for (const s of cat.sources) for (const f of s.fields) assert.ok(!/phone|email/i.test(f.field), `${s.source}.${f.field}`);
  await bad(call(owner, 'analytics_run', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, filters: [{ field: 'phone', op: 'contains', value: '98' }] }, p_max: 10 }), '22023');
  await bad(call(owner, 'analytics_run', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'email' }] }, p_max: 10 }), '22023');
  const exp = await ok(call(owner, 'analytics_export', { p_org: org, p_q: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'source' }] } }));
  assert.ok(!JSON.stringify(exp).includes('+919822220031') && !JSON.stringify(exp).includes('report@example.com'));
});

// ---------- invoice PDF: authorization outcomes and Unicode ----------
import { handleInvoicePdf } from '../src/lib/billing/pdfRoute.ts';
import { invoicePdf, unsupportedCharacters } from '../src/lib/billing/pdf.ts';
const SNAP = { number: 'INV-00007', business: 'Café Δελτα', currency: 'INR', issue_date: '2026-01-05', due_date: '2026-02-05', notes: 'धन्यवाद। Спасибо', bill_to: { name: 'राजेश कुमार', email: 'r@example.com', phone: '+919800000001' },
  lines: [{ description: 'Sửa chữa – Đèn ₹', quantity: '1', unit_price: '10', discount: '0', net: '10', tax: '0', line_total: '10' }], subtotal: '10', discount_total: '0', tax_total: '0', total: '10' };

test('invoice PDF supports Latin, Vietnamese, Greek, Cyrillic and Devanagari text, ₹, and reports what it cannot draw', async () => {
  assert.deepEqual(unsupportedCharacters('Café Δελτα Спасибо राजेश कुमार Đèn ₹ Zoë Ünï ‘quotes’ – —'), []);
  assert.deepEqual(unsupportedCharacters('日本語 ☃ ok').sort(), ['日', '本', '語', '☃'].sort());
  const a = await invoicePdf(SNAP), b = await invoicePdf(SNAP);
  assert.ok(a.subarray(0, 5).toString() === '%PDF-' && a.toString('latin1').trimEnd().endsWith('%%EOF')); assert.deepEqual(a, b, 'deterministic with Unicode text');
  assert.ok(a.length > 5000, 'fonts are embedded'); assert.notDeepEqual(a, await invoicePdf({ ...SNAP, total: '11' }));
  assert.ok((await invoicePdf({ ...SNAP, business: '日本語 مرحبا', notes: '☃' })).length > 1000, 'unsupported scripts degrade to "?" without failing');
});

test('invoice PDF endpoint: unauthenticated, invalid id, cross-organization, wrong role, draft and success', async () => {
  const A = await fresh(CFG), B = await fresh(CFG);
  const draft = await ok(call(MGR, 'invoice_save_draft', { p_org: A.org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'Café ₹', quantity: '1', unit_price: '100', tax_keys: [] }] }));
  await ok(call(MGR, 'invoice_issue', { p_org: A.org, p_id: draft }));
  const deps = (user, org) => ({ organization: async () => (user ? { organizationId: org } : null), rpc: async (o, id) => mkRpc(user)('invoice_pdf_access', { p_org: o, p_id: id }) });
  const code = async (user, org, id) => (await handleInvoicePdf(deps(user, org), id)).status;
  assert.equal(await code(null, A.org, draft), 401, 'anonymous');
  assert.equal(await code(null, A.org, 'not-an-id'), 401, 'anonymous callers learn nothing about ids, valid or not');
  assert.equal(await code(MGR, A.org, 'not-an-id'), 404); assert.equal(await code(MGR, A.org, '../../etc/passwd'), 404);
  assert.equal(await code(MGR, A.org, '00000000-0000-0000-0000-000000000000'), 404, 'unknown id');
  assert.equal(await code(B.owner, B.org, draft), 404, 'another organization looks exactly like a missing invoice');
  assert.equal(await code(B.owner, A.org, draft), 403, 'a non-member naming this organization is refused');
  assert.equal(await code(EMP, A.org, draft), 403, 'employees cannot download invoices');
  const ok1 = await handleInvoicePdf(deps(MGR, A.org), draft);
  assert.equal(ok1.status, 200); assert.equal(ok1.headers.get('content-type'), 'application/pdf'); assert.equal(ok1.headers.get('cache-control'), 'no-store'); assert.match(ok1.headers.get('content-disposition'), /^attachment; filename="invoice-[A-Za-z0-9-]+\.pdf"$/);
  assert.equal(Buffer.from(await ok1.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name='invoice.pdf_downloaded'`, [A.org]))[0].n, 1, 'the download was audited, the refusals were not');
  // an unissued draft is not downloadable
  const d2 = await ok(call(MGR, 'invoice_save_draft', { p_org: A.org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '1', tax_keys: [] }] }));
  assert.equal(await code(MGR, A.org, d2), 404);
  // errors never leak internals
  const boom = await handleInvoicePdf({ organization: async () => ({ organizationId: A.org }), rpc: async () => ({ data: null, error: { code: 'XX000', message: 'relation "secret" exploded' } }) }, draft);
  assert.equal(boom.status, 500); assert.ok(!(await boom.text()).includes('secret'));
});
