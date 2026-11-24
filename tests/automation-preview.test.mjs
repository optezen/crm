// Pure-logic tests for the automation builder's preview, wording, problems and layout.
// The parity test runs the SAME corpus through src/lib/automation/preview.ts and the REAL SQL functions (extracted verbatim from migration 0007, executed in PGlite = real PostgreSQL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { evalCondition, evalMatch, preview, renderTemplate, sampleFor } from '../src/lib/automation/preview.ts';
import { describeStep, problemsOf, summarize, issueMap } from '../src/lib/builder/workflowText.ts';
import { autoLayout, definitionToGraph, graphToDefinition, isLegacyRow, relayout, addNode, blankAction, NODE_H, GAP_Y } from '../src/lib/builder/workflowGraph.ts';
import { validateAutomation } from '../src/lib/automation/validate.ts';

const sql = readFileSync(new URL('../supabase/migrations/0007_automation_engine.sql', import.meta.url), 'utf8');
const helpers = sql.slice(sql.indexOf('-- ---------- small pure helpers'), sql.indexOf('-- ---------- definition validator'));
const db = new PGlite(); await db.exec(helpers);
const today = (await db.query('select current_date::text d')).rows[0].d;
const nest = s => { const o = {}; for (const [k, v] of Object.entries(s)) { const [a, b] = k.split('.'); (o[a] ??= {})[b] = v; } return o; };

const SAMPLES = [
  { 'lead.source': 'Website', 'lead.stage': 'New', 'lead.full_name': 'Asha Patel', 'lead.summary': '', 'lead.created_at': '2024-05-01', 'record.price': '10', 'record.qty': '10.00', 'record.when': 'not a date', 'record.neg': '-3', 'record.big': '1234567890123' },
  { 'lead.source': 'phone', 'lead.summary': '   ', 'record.price': 'ten', 'record.when': '2030-02-30', 'record.date': '2031-01-01T10:00:00Z' },
];
const FIELDS = ['lead.source', 'lead.stage', 'lead.summary', 'lead.missing', 'lead.created_at', 'record.price', 'record.qty', 'record.when', 'record.neg', 'record.big', 'record.date', 'lead.full_name'];
const VALUES = ['website', 'WEBSITE', 'New', '', 'Asha', 'asha', '10', '10.0', '9', '-3', 'ten', '2025-01-01', 'today', '2030-02-30', 'nope', 1234567890123];
const OPS = ['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt', 'before', 'after'];

test('preview condition logic matches the real SQL automation_cond on a large corpus', async () => {
  let n = 0;
  for (const s of SAMPLES) for (const field of FIELDS) for (const op of OPS) for (const value of (op === 'empty' || op === 'not_empty' ? [undefined] : VALUES)) {
    const c = value === undefined ? { field, op } : { field, op, value };
    const want = (await db.query('select public.automation_cond($1::jsonb, $2::jsonb) r', [JSON.stringify(c), JSON.stringify(nest(s))])).rows[0].r;
    assert.equal(evalCondition(c, s, today), want, `${JSON.stringify(c)} on ${JSON.stringify(s)}`); n++;
  }
  assert.ok(n > 2500, `corpus size ${n}`);
});
test('AND / OR / empty match mirror SQL automation_eval', async () => {
  const s = SAMPLES[0];
  for (const m of [undefined, { op: 'and', conditions: [] }, { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }, { field: 'lead.stage', op: 'eq', value: 'New' }] }, { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }, { field: 'lead.stage', op: 'eq', value: 'Won' }] },
    { op: 'or', conditions: [{ field: 'lead.source', op: 'eq', value: 'x' }, { field: 'lead.stage', op: 'eq', value: 'New' }] }, { op: 'or', conditions: [{ field: 'lead.source', op: 'eq', value: 'x' }] }]) {
    const want = (await db.query('select public.automation_eval($1::jsonb, $2::jsonb) r', [JSON.stringify(m ?? {}), JSON.stringify(nest(s))])).rows[0].r;
    assert.equal(evalMatch(m, s, today), want, JSON.stringify(m));
  }
});
test('templates match SQL automation_tpl', async () => {
  const s = { 'lead.full_name': 'Asha Patel', 'lead.phone': '+91 1', 'record.x': 'y'.repeat(600) };
  for (const t of ['Call {{lead.full_name}}', '{{lead.full_name}} / {{lead.phone}}', 'Unknown {{lead.nope}} stays empty', '{{ lead.full_name }} has spaces', '{{record.x}}', 'no tokens', '{{lead.full_name}}{{lead.full_name}}']) {
    assert.equal(renderTemplate(t, s), (await db.query('select public.automation_tpl($1, $2::jsonb) r', [t, JSON.stringify(nest(s))])).rows[0].r, t);
  }
});

const who = id => (id === 'u1' ? 'sam@x.test' : id.slice(0, 8)); const label = p => ({ 'lead.source': 'Lead source', 'lead.stage': 'Lead stage', 'lead.full_name': 'Contact name' })[p] ?? p;
const DEF = { trigger: { event: 'lead.created' }, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }] }, actions: [{ type: 'assign_round_robin' }, { type: 'wait', minutes: 120 }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }, { type: 'request_integration', channel: 'whatsapp', message: 'Hi {{lead.full_name}}', to: 'lead_contact' }] };
const ctxOf = o => ({ today, who, label }) && o;

test('preview: matching sample lists every action, nothing is sent, wait does not block', () => {
  const p = preview(DEF, { 'lead.source': 'website', 'lead.full_name': 'Asha Patel', 'lead.assigned_to': '' }, { today, who, label });
  assert.equal(p.matched, true); assert.equal(p.steps.length, 6);
  assert.match(p.steps[1].detail, /✓ Lead source equals “website”/); assert.match(p.steps[4].detail, /“Call Asha Patel” would be created/); assert.match(p.steps[5].detail, /Nothing is sent/);
  assert.equal(p.steps[3].outcome, 'waits'); assert.match(p.headline, /Nothing was changed or sent/);
});
test('preview: unmet condition stops everything and says so; only_if_unassigned skips an assigned lead', () => {
  const p = preview(DEF, { 'lead.source': 'phone', 'lead.full_name': 'X' }, { today, who, label });
  assert.equal(p.matched, false); assert.equal(p.steps[1].outcome, 'stops'); assert.match(p.steps[1].detail, /would stop here/); assert.ok(p.steps.slice(2).every(s => s.outcome === 'skipped'));
  const q = preview(DEF, { 'lead.source': 'website', 'lead.assigned_to': 'someone' }, { today, who, label });
  assert.equal(q.steps[2].outcome, 'skipped'); assert.match(q.steps[2].detail, /already has an assignee/);
});
test('preview module is pure: no network, server action or database import', () => {
  const src = readFileSync(new URL('../src/lib/automation/preview.ts', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '(.*)'/gm)].map(m => m[1]), ['./types.ts']); assert.ok(!/fetch\(|supabase|use server|rpc\(/.test(src));
  assert.ok(Object.keys(sampleFor([['lead.source', 'x'], ['record.a', 'y']], today)).length === 2);
});

test('wording: the summary is one plain sentence, template tokens are shown as field names, node captions use labels', () => {
  const { graph } = definitionToGraph(DEF); const s = summarize(graph, who, label);
  assert.equal(s.text, 'When a lead is created, and only if Lead source equals “website”, Optizen will assign the lead to the next employee in turn (only if it has no assignee yet), then wait 2 hours, then create a follow-up task “Call [Contact name]”, due in 1 day, for the lead’s assignee, then request a whatsapp message “Hi [Contact name]” (recorded only until a whatsapp provider is connected).');
  assert.ok(!s.text.includes('{{')); assert.equal(s.steps.length, 4);
  assert.equal(describeStep(graph.nodes[1], who, label).kind, 'Only if'); assert.equal(describeStep(graph.nodes[0], who, label).kind, 'When this happens'); assert.match(describeStep(graph.nodes[4], who, label).sub, /Call \[Contact name\]/);
  const bare = definitionToGraph({ trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Hi' }] }).graph; assert.match(summarize(bare, who, label).text, /^When a lead is created, Optizen will notify the person who triggered it: “Hi”\.$/);
  assert.match(summarize({ nodes: [bare.nodes[0]], edges: [] }, who, label).text, /nothing is set to happen yet/);
});

test('problems: blank condition value is flagged specifically; the engine grammar is unchanged (an empty text value still compiles)', () => {
  const blank = { ...DEF, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: '' }] } };
  const { graph } = definitionToGraph(blank);
  assert.equal(graphToDefinition(graph).ok, true, 'grammar/validator untouched: blank text still compiles');
  assert.equal(validateAutomation(blank).ok, true);
  const ps = problemsOf(graph, label); assert.equal(ps.length, 1); assert.match(ps[0].message, /Condition 1 \(Lead source equals\) needs a value/); assert.match(ps[0].fix, /is empty/);
  assert.ok(issueMap(ps)[graph.nodes[1].id]);
  const gt = definitionToGraph({ ...DEF, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'gt', value: '' }] } }).graph; assert.equal(problemsOf(gt, label).length, 1, 'one clear message, not two');
  const fine = definitionToGraph(DEF).graph; assert.deepEqual(problemsOf(fine, label), []);
  const isEmpty = definitionToGraph({ ...DEF, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'empty' }] } }).graph; assert.deepEqual(problemsOf(isEmpty, label), []);
});
test('problems: structural issues from the validator still surface (unconnected step)', () => {
  const g = definitionToGraph(DEF).graph; const extra = { ...g, nodes: [...g.nodes, { id: 'n9', kind: 'action', action: blankAction('notify') }] };
  assert.ok(problemsOf(extra, label).some(p => p.nodeId === 'n9'));
});

test('layout: steps stack top to bottom in run order; inserting re-stacks; the old horizontal row is detected', () => {
  const { graph, pos } = definitionToGraph(DEF); const ids = graph.nodes.map(n => n.id);
  assert.deepEqual(ids.map(i => pos[i].y), ids.map((_, k) => 40 + k * (NODE_H + GAP_Y))); assert.ok(ids.every(i => pos[i].x === 60));
  const g2 = addNode(graph, { id: 'n9', kind: 'action', action: blankAction('notify') }, ids[2]); const p2 = relayout(g2, pos);
  assert.ok(p2.n9.y > p2[ids[2]].y && p2.n9.y < p2[ids[3]].y, 'new step sits between its neighbours');
  assert.equal(isLegacyRow(ids, Object.fromEntries(ids.map((i, k) => [i, { x: 40 + k * 300, y: 120 }]))), true);
  assert.equal(isLegacyRow(ids, pos), false); assert.equal(isLegacyRow(['a'], { a: { x: 1, y: 1 } }), false);
  assert.deepEqual(Object.keys(autoLayout(['a', 'b'])), ['a', 'b']);
});
