// Visual workflow model: serialization, validation, unsafe-structure rejection, undo/redo. Pure; no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addNode, blankAction, canConnect, chainOf, connect, definitionToGraph, graphToDefinition, moveInChain, nodeIssues, removeNode, updateNode, actionsFor } from '../src/lib/builder/workflowGraph.ts';
import { commit, history, redo, seal, undo } from '../src/lib/builder/history.ts';
import { validateAutomation } from '../src/lib/automation/validate.ts';

const DEF = { trigger: { event: 'lead.created' }, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }] },
  actions: [{ type: 'assign_round_robin' }, { type: 'wait', minutes: 30 }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };

test('definition -> graph -> definition is lossless and layout never enters the definition', () => {
  const { graph, pos } = definitionToGraph(DEF);
  assert.deepEqual(graph.nodes.map(n => n.kind), ['trigger', 'condition', 'action', 'delay', 'action']);
  const r = graphToDefinition(graph); assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.definition, DEF);
  assert.ok(!JSON.stringify(r.definition).includes('"x"'), 'no coordinates in the executable definition');
  assert.equal(Object.keys(pos).length, 5);
});
test('saved layout is reused only when it still matches the steps', () => {
  const a = definitionToGraph(DEF).graph.nodes.map(n => n.id);
  const layout = { v: 1, order: ['t1', 'c1', 'a1', 'd1', 'a2'], pos: { t1: { x: 1, y: 2 }, c1: { x: 3, y: 4 }, a1: { x: 5, y: 6 }, d1: { x: 7, y: 8 }, a2: { x: 9, y: 10 } }, view: { x: 0, y: 0, z: 1 } };
  const r = definitionToGraph(DEF, layout); assert.deepEqual(r.graph.nodes.map(n => n.id), layout.order); assert.deepEqual(r.pos.c1, { x: 3, y: 4 });
  const stale = definitionToGraph({ ...DEF, actions: DEF.actions.slice(0, 2) }, layout); assert.deepEqual(stale.graph.nodes.map(n => n.id), a.slice(0, 4), 'stale layout ignored, auto layout used');
  assert.deepEqual(definitionToGraph(DEF, { ...layout, order: ['t1', 't1', 'a1', 'd1', 'a2'] }).graph.nodes.map(n => n.id), a, 'duplicate ids rejected');
});
test('branching, merging, loops, second conditions and mid-chain conditions are refused', () => {
  const { graph } = definitionToGraph(DEF); const [t, c, a1, d, a2] = graph.nodes.map(n => n.id);
  assert.match(canConnect(graph, a1, a2).reason ?? '', /one next step|before it/);           // a1 already has a successor
  const open = { ...graph, edges: graph.edges.filter(e => !(e.from === d && e.to === a2)) };
  assert.equal(canConnect(open, d, a2).ok, true);
  const loop = { ...graph, edges: graph.edges.filter(e => e.from !== a2 && e.to !== t) };
  assert.match(canConnect(loop, a2, t).reason, /trigger/);
  const noTail = { ...graph, edges: graph.edges.filter(e => e.from !== d) };                 // d has no successor now, a2 has a predecessor? no
  assert.match(canConnect(noTail, a2, a1).reason, /already has a step before it|loop/);
  assert.match(canConnect(graph, a1, a1).reason, /itself/);
  // a loop back to a middle step
  const chain = { nodes: graph.nodes, edges: graph.edges.filter(e => !(e.from === a1 && e.to === d)) };
  assert.match(canConnect({ ...chain, edges: [...chain.edges] }, d, a1).reason, /loop|already has a step before|one next step/);
  // second condition & condition after an action
  let g2 = addNode(graph, { id: 'n9', kind: 'condition', op: 'or', conditions: [{ field: 'lead.stage', op: 'eq', value: 'New' }] }, a1);
  assert.equal(g2, graph, 'a condition cannot be inserted after an action');
  const cond2 = { nodes: [...graph.nodes, { id: 'n9', kind: 'condition', op: 'and', conditions: [{ field: 'lead.stage', op: 'eq', value: 'New' }] }], edges: graph.edges };
  assert.match(canConnect(cond2, a2, 'n9').reason, /right after the trigger/);
  assert.match(canConnect({ nodes: cond2.nodes, edges: graph.edges.filter(e => e.from !== t && e.to !== c) }, t, 'n9').ok ? 'ok' : 'no', /ok/); // trigger -> new condition is fine structurally (second condition caught on save)
  const two = { nodes: cond2.nodes, edges: [...graph.edges.filter(e => e.from !== t && e.to !== c), { from: t, to: 'n9' }, { from: 'n9', to: c }] };
  const r = graphToDefinition(two); assert.equal(r.ok, false);
});
test('graphToDefinition reports disconnected nodes, missing trigger/actions and per-node validator errors', () => {
  const { graph } = definitionToGraph(DEF);
  const loose = { ...graph, nodes: [...graph.nodes, { id: 'n9', kind: 'action', action: { type: 'notify', recipient: 'event_actor', title: 'hi' } }] };
  const r = graphToDefinition(loose); assert.equal(r.ok, false); assert.equal(r.issues[0].nodeId, 'n9'); assert.match(r.issues[0].message, /not connected/);
  assert.equal(graphToDefinition({ nodes: [], edges: [] }).ok, false);
  const onlyTrig = { nodes: [graph.nodes[0]], edges: [] }; assert.match(graphToDefinition(onlyTrig).issues[0].message, /at least one action/);
  // a lead-only action under a record trigger is flagged on that node, using the engine's own validator
  const rec = { nodes: [{ id: 'n1', kind: 'trigger', event: 'record.created', object: 'vehicles' }, { id: 'n2', kind: 'action', action: { type: 'assign_round_robin' } }], edges: [{ from: 'n1', to: 'n2' }] };
  const rr = graphToDefinition(rec); assert.equal(rr.ok, false); assert.equal(rr.issues[0].nodeId, 'n2'); assert.ok(nodeIssues(rec).n2);
  assert.ok(!actionsFor('record.created').includes('assign_round_robin')); assert.ok(actionsFor('lead.created').includes('assign_round_robin'));
  const emptyCond = { nodes: [graph.nodes[0], { id: 'c', kind: 'condition', op: 'and', conditions: [] }, graph.nodes[2]], edges: [{ from: graph.nodes[0].id, to: 'c' }, { from: 'c', to: graph.nodes[2].id }] };
  assert.match(graphToDefinition(emptyCond).issues.map(i => i.message).join(), /at least one condition/);
  const branch = { ...graph, edges: [...graph.edges, { from: graph.nodes[0].id, to: graph.nodes[3].id }] };
  assert.match(graphToDefinition(branch).issues[0].message, /Branching|Merging/);
  const cyc = { nodes: graph.nodes, edges: [...graph.edges, { from: graph.nodes[4].id, to: graph.nodes[2].id }] };
  assert.equal(graphToDefinition(cyc).ok, false);
});
test('adding, deleting (bridging), reordering and editing keep the graph executable', () => {
  let { graph } = definitionToGraph(DEF);
  const ids = graph.nodes.map(n => n.id);
  graph = addNode(graph, { id: 'n9', kind: 'action', action: { type: 'notify', recipient: 'event_actor', title: 'Hello' } }, ids[2]);
  assert.deepEqual(chainOf(graph).chain.map(n => n.id), [ids[0], ids[1], ids[2], 'n9', ids[3], ids[4]]);
  let r = graphToDefinition(graph); assert.ok(r.ok); assert.equal(r.definition.actions[1].type, 'notify');
  graph = removeNode(graph, 'n9'); r = graphToDefinition(graph); assert.ok(r.ok); assert.deepEqual(r.definition, DEF);
  graph = moveInChain(graph, ids[4], -1); r = graphToDefinition(graph); assert.ok(r.ok); assert.deepEqual(r.definition.actions.map(a => a.type), ['assign_round_robin', 'create_task', 'wait']);
  assert.equal(moveInChain(graph, ids[1], 1), graph, 'condition cannot be reordered'); assert.equal(removeNode(graph, ids[0]), graph, 'trigger cannot be deleted');
  graph = updateNode(graph, { ...graph.nodes.find(n => n.id === ids[3]), action: { type: 'wait', minutes: 5 } });
  assert.equal(graphToDefinition(graph).definition.actions.find(a => a.type === 'wait').minutes, 5);
  const bad = updateNode(graph, { ...graph.nodes.find(n => n.id === ids[3]), action: { type: 'wait', minutes: 0 } });
  assert.equal(graphToDefinition(bad).ok, false);
  assert.equal(connect(graph, ids[0], ids[4]), graph, 'illegal connection is a no-op');
});
test('every graph the canvas can produce is accepted by the validator the engine uses', () => {
  for (const a of ['assign_round_robin', 'create_task', 'notify', 'wait', 'request_integration']) {
    let { graph } = definitionToGraph({ trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] });
    graph = addNode(graph, { id: 'n9', kind: a === 'wait' ? 'delay' : 'action', action: a === 'notify' ? { ...blankAction(a), title: 'Hi' } : blankAction(a) }, graph.nodes[1].id);
    const r = graphToDefinition(graph); if (a === 'request_integration' || a === 'notify' || a === 'create_task' || a === 'assign_round_robin' || a === 'wait') assert.ok(r.ok, `${a}: ${JSON.stringify(r)}`);
    if (r.ok) assert.ok(validateAutomation(r.definition).ok);
  }
});
test('undo/redo with coalescing, capacity and sealing', () => {
  let h = history(0);
  h = commit(h, 1); h = commit(h, 2, 'drag'); h = commit(h, 3, 'drag'); h = commit(h, 4, 'drag');
  assert.equal(h.present, 4); h = undo(h); assert.equal(h.present, 1, 'the whole drag is one step');
  h = redo(h); assert.equal(h.present, 4); h = undo(undo(h)); assert.equal(h.present, 0); assert.equal(undo(h), h);
  h = commit(h, 9); assert.equal(h.future.length, 0, 'a new edit clears redo'); assert.equal(commit(h, 9), h, 'no-op edits are not recorded');
  h = commit(h, 10, 'type'); h = seal(h); h = commit(h, 11, 'type'); assert.equal(undo(h).present, 10);
  let big = history(0); for (let i = 1; i <= 250; i++) big = commit(big, i); assert.equal(big.past.length, 100);
});

import { applyGridEdit, moveWidget, resizeFromDrag } from '../src/lib/builder/dashboardGrid.ts';
test('dashboard grid: reorder, drag-resize and keyboard resize snap to the 12-column grid and clamp', () => {
  const l = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveWidget(l, 0, 2), ['b', 'c', 'a', 'd']); assert.deepEqual(moveWidget(l, 3, 0), ['d', 'a', 'b', 'c']);
  assert.equal(moveWidget(l, 1, 1), l); assert.equal(moveWidget(l, 0, 9), l); assert.equal(moveWidget(l, -1, 2), l); assert.deepEqual(l, ['a', 'b', 'c', 'd'], 'input untouched');
  const col = 100; // px per column; gap 12
  assert.deepEqual(resizeFromDrag({ w: 3, h: 2 }, 112, 96, col), { w: 4, h: 3 });
  assert.deepEqual(resizeFromDrag({ w: 3, h: 2 }, -5000, -5000, col), { w: 1, h: 1 });
  assert.deepEqual(resizeFromDrag({ w: 3, h: 2 }, 9000, 9000, col), { w: 12, h: 12 });
  assert.deepEqual(applyGridEdit({ w: 12, h: 1 }, 'ArrowRight'), { w: 12, h: 1 }); assert.deepEqual(applyGridEdit({ w: 5, h: 4 }, 'ArrowUp'), { w: 5, h: 3 }); assert.deepEqual(applyGridEdit({ w: 5, h: 4 }, 'Tab'), { w: 5, h: 4 });
});
