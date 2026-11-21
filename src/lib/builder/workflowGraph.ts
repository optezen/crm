// Visual workflow model. The canvas is only a *view* of the executable definition: the engine runs one trigger, an optional single
// condition group (evaluated once, before the first action) and an ordered list of actions (delays are `wait` actions).
// So the only graph the canvas can express is a straight chain trigger -> [condition] -> action/delay -> ... Branches, merges,
// loops and a second condition are rejected here rather than invented. Layout (positions, viewport) is separate metadata.
import { ACTION_TYPES, scopeOf, type Action, type ActionType, type AutomationDefinition, type Condition, type Match } from '../automation/types.ts';
import { validateAutomation } from '../automation/validate.ts';

export type NodeKind = 'trigger' | 'condition' | 'action' | 'delay';
export type WaitAction = Extract<Action, { type: 'wait' }>;
export type GraphNode =
  | { id: string; kind: 'trigger'; event: string; object?: string }
  | { id: string; kind: 'condition'; op: 'and' | 'or'; conditions: Condition[] }
  | { id: string; kind: 'action'; action: Exclude<Action, WaitAction> }
  | { id: string; kind: 'delay'; action: WaitAction };
export type Edge = { from: string; to: string };
export type Graph = { nodes: GraphNode[]; edges: Edge[] };
export type Layout = { v: 1; order: string[]; pos: Record<string, { x: number; y: number }>; view?: { x: number; y: number; z: number } };
type TriggerNode = Extract<GraphNode, { kind: 'trigger' }>;
const isTrigger = (n: GraphNode): n is TriggerNode => n.kind === 'trigger';
export type Issue = { nodeId?: string; message: string };

export const NODE_W = 230, NODE_H = 92, GAP_X = 70;
const ID = /^[a-z0-9_-]{1,24}$/;

export const blankAction = (a: ActionType): Action => ({
  assign_round_robin: { type: 'assign_round_robin' }, assign_lead: { type: 'assign_lead', user_id: '' }, create_task: { type: 'create_task', title: 'Follow up with {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' },
  update_task_status: { type: 'update_task_status', status: 'done', outcome: 'Completed automatically' }, update_record: { type: 'update_record', field: '', value: '' }, notify: { type: 'notify', recipient: 'event_actor', title: '' },
  wait: { type: 'wait', minutes: 60 }, request_integration: { type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}' },
} as Record<ActionType, Action>)[a];

/** Which actions the engine accepts for a trigger scope (mirrors automation_validate; the validator remains the gate). */
export function actionsFor(event: string): ActionType[] {
  const scope = scopeOf(event), leadish = scope === 'lead' || scope === 'task';
  return ACTION_TYPES.filter(a => (a === 'assign_round_robin' || a === 'assign_lead' || a === 'create_task') ? leadish : a === 'update_task_status' ? scope === 'task' : a === 'update_record' ? scope === 'record' : true);
}

export const nextId = (g: Graph): string => { let n = 0; for (const x of g.nodes) { const m = /^n(\d+)$/.exec(x.id); if (m) n = Math.max(n, Number(m[1])); } return `n${n + 1}`; };
const outOf = (g: Graph, id: string) => g.edges.filter(e => e.from === id), inTo = (g: Graph, id: string) => g.edges.filter(e => e.to === id);
const nodeOf = (g: Graph, id: string) => g.nodes.find(n => n.id === id);

/** Nodes reachable from `start` following edges (cycle-safe). */
function reach(g: Graph, start: string): Set<string> {
  const seen = new Set<string>(), stack = [start];
  while (stack.length) { const c = stack.pop()!; for (const e of outOf(g, c)) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); } }
  return seen;
}

/** Whether `from -> to` may be drawn. Every rule exists because the engine could not execute the resulting graph. */
export function canConnect(g: Graph, from: string, to: string): { ok: true } | { ok: false; reason: string } {
  const a = nodeOf(g, from), b = nodeOf(g, to);
  if (!a || !b) return { ok: false, reason: 'Unknown node.' };
  if (from === to) return { ok: false, reason: 'A step cannot connect to itself.' };
  if (b.kind === 'trigger') return { ok: false, reason: 'Nothing can lead into the trigger.' };
  if (g.edges.some(e => e.from === from && e.to === to)) return { ok: false, reason: 'Those steps are already connected.' };
  if (outOf(g, from).length) return { ok: false, reason: 'A step can only lead to one next step. Automations run in a single sequence; branching is not supported by the engine.' };
  if (inTo(g, to).length) return { ok: false, reason: 'That step already has a step before it. Automations run in a single sequence.' };
  if (reach(g, to).has(from)) return { ok: false, reason: 'That would create a loop. Automations cannot repeat.' };
  if (b.kind === 'condition' && a.kind !== 'trigger') return { ok: false, reason: 'Conditions are checked once, right after the trigger, before any action runs. Connect the condition directly to the trigger.' };
  if (a.kind === 'condition' && b.kind === 'condition') return { ok: false, reason: 'Only one condition group is supported. Combine the tests inside it with AND / OR.' };
  return { ok: true };
}

/** Linear order from the trigger following edges; `rest` are nodes not on that chain. */
export function chainOf(g: Graph): { chain: GraphNode[]; rest: GraphNode[] } {
  const t = g.nodes.find(n => n.kind === 'trigger'); if (!t) return { chain: [], rest: g.nodes };
  const chain: GraphNode[] = [t], seen = new Set([t.id]);
  for (let cur: GraphNode = t; ;) { const e: Edge | undefined = outOf(g, cur.id)[0]; const nx: GraphNode | undefined = e ? nodeOf(g, e.to) : undefined; if (!nx || seen.has(nx.id)) break; chain.push(nx); seen.add(nx.id); cur = nx; }
  return { chain, rest: g.nodes.filter(n => !seen.has(n.id)) };
}

/** Per-node problems, found by running the real validator on that node alone (so the canvas never invents rules). */
export function nodeIssues(g: Graph): Record<string, string> {
  const t = g.nodes.find(isTrigger); const out: Record<string, string> = {};
  if (!t) return out;
  const trigger = { event: t.event, ...(t.object ? { object: t.object } : {}) };
  const safe: Action = { type: 'notify', recipient: 'event_actor', title: 'x' };
  const check = (id: string, def: unknown) => { const r = validateAutomation(def); if (!r.ok) out[id] = r.error.replace(/^Action 1 /, 'This step '); };
  check(t.id, { trigger, actions: [safe] });
  for (const n of g.nodes) {
    if (n.kind === 'action' || n.kind === 'delay') check(n.id, { trigger, actions: [n.action] });
    if (n.kind === 'condition') { if (!n.conditions.length) out[n.id] = 'Add at least one condition, or delete this step.'; else check(n.id, { trigger, match: { op: n.op, conditions: n.conditions }, actions: [safe] }); }
  }
  return out;
}

/** Graph -> executable definition, or every reason it cannot be executed. */
export function graphToDefinition(g: Graph): { ok: true; definition: AutomationDefinition; order: string[] } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const triggers = g.nodes.filter(isTrigger);
  if (triggers.length !== 1) return { ok: false, issues: [{ message: triggers.length ? 'An automation has exactly one trigger.' : 'Add a trigger.' }] };
  for (const n of g.nodes) {
    if (outOf(g, n.id).length > 1) issues.push({ nodeId: n.id, message: 'This step leads to more than one step. Branching is not supported.' });
    if (inTo(g, n.id).length > 1) issues.push({ nodeId: n.id, message: 'More than one step leads into this step. Merging is not supported.' });
  }
  const t = triggers[0]!;
  if (inTo(g, t.id).length) issues.push({ nodeId: t.id, message: 'Nothing can lead into the trigger.' });
  if (issues.length) return { ok: false, issues };
  const { chain, rest } = chainOf(g);
  for (const n of rest) issues.push({ nodeId: n.id, message: 'This step is not connected to the trigger, so it would never run. Connect it or delete it.' });
  const conds = chain.filter(n => n.kind === 'condition');
  if (conds.length > 1) issues.push({ nodeId: conds[1]!.id, message: 'Only one condition group is supported.' });
  const ci = chain.findIndex(n => n.kind === 'condition');
  if (ci > 1) issues.push({ nodeId: chain[ci]!.id, message: 'The condition must come directly after the trigger.' });
  const per = nodeIssues(g); for (const [nodeId, message] of Object.entries(per)) issues.push({ nodeId, message });
  const acts = chain.filter((n): n is Extract<GraphNode, { kind: 'action' | 'delay' }> => n.kind === 'action' || n.kind === 'delay');
  if (!acts.length) issues.push({ message: 'Add at least one action.' });
  if (issues.length) return { ok: false, issues };
  const cond = conds[0] as Extract<GraphNode, { kind: 'condition' }> | undefined;
  const definition: AutomationDefinition = { trigger: { event: t.event, ...(t.object ? { object: t.object } : {}) },
    ...(cond ? { match: { op: cond.op, conditions: cond.conditions } as Match } : {}), actions: acts.map(n => n.action) };
  const v = validateAutomation(definition);
  if (!v.ok) return { ok: false, issues: [{ message: v.error }] };
  return { ok: true, definition: v.value, order: chain.map(n => n.id) };
}

/** Executable definition -> graph. Saved layout is reused only when it still describes the same number of steps. */
export function definitionToGraph(d: AutomationDefinition, layout?: Layout | null): { graph: Graph; pos: Layout['pos']; view?: Layout['view'] } {
  const kinds: GraphNode[] = [{ id: '', kind: 'trigger', event: d.trigger.event, ...(d.trigger.object ? { object: d.trigger.object } : {}) }];
  if (d.match && d.match.conditions.length) kinds.push({ id: '', kind: 'condition', op: d.match.op, conditions: d.match.conditions });
  for (const a of d.actions) kinds.push(a.type === 'wait' ? { id: '', kind: 'delay', action: a } : { id: '', kind: 'action', action: a as Exclude<Action, WaitAction> });
  const reuse = !!layout && layout.order.length === kinds.length && new Set(layout.order).size === kinds.length && layout.order.every(i => ID.test(i));
  const nodes = kinds.map((n, i) => ({ ...n, id: reuse ? layout!.order[i]! : `n${i + 1}` }) as GraphNode);
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id }));
  const pos: Layout['pos'] = {};
  nodes.forEach((n, i) => { pos[n.id] = reuse && layout!.pos[n.id] ? layout!.pos[n.id]! : { x: 40 + i * (NODE_W + GAP_X), y: 120 }; });
  return { graph: { nodes, edges }, pos, view: reuse ? layout!.view : undefined };
}

// ---- edits (all return a new graph; the caller records history) ----
export function addNode(g: Graph, n: GraphNode, afterId?: string | null): Graph {
  const nodes = [...g.nodes, n]; let edges = g.edges;
  const after = afterId ? nodeOf(g, afterId) : null;
  if (after) {
    if (n.kind === 'condition' && after.kind !== 'trigger') return g; // a condition only fits right after the trigger
    const next = outOf(g, after.id)[0];
    if (next && n.kind !== 'condition' && nodeOf(g, next.to)?.kind === 'condition') return g;
    edges = g.edges.filter(e => e !== next).concat([{ from: after.id, to: n.id }], next ? [{ from: n.id, to: next.to }] : []);
  }
  return { nodes, edges };
}
/** Deleting a middle step reconnects its neighbours so the sequence stays whole. The trigger cannot be deleted. */
export function removeNode(g: Graph, id: string): Graph {
  const n = nodeOf(g, id); if (!n || n.kind === 'trigger') return g;
  const prev = inTo(g, id)[0], next = outOf(g, id)[0];
  const edges = g.edges.filter(e => e.from !== id && e.to !== id);
  if (prev && next && canConnect({ nodes: g.nodes.filter(x => x.id !== id), edges }, prev.from, next.to).ok) edges.push({ from: prev.from, to: next.to });
  return { nodes: g.nodes.filter(x => x.id !== id), edges };
}
export const removeEdge = (g: Graph, e: Edge): Graph => ({ ...g, edges: g.edges.filter(x => !(x.from === e.from && x.to === e.to)) });
export function connect(g: Graph, from: string, to: string): Graph { return canConnect(g, from, to).ok ? { ...g, edges: [...g.edges, { from, to }] } : g; }
export const updateNode = (g: Graph, n: GraphNode): Graph => ({ ...g, nodes: g.nodes.map(x => (x.id === n.id ? n : x)) });
/** Keyboard alternative to dragging a step to another place in the sequence: swaps it with its neighbour (never past the trigger / condition). */
export function moveInChain(g: Graph, id: string, dir: -1 | 1): Graph {
  const { chain, rest } = chainOf(g); const i = chain.findIndex(n => n.id === id); const j = i + dir;
  if (i < 1 || j < 1 || j >= chain.length || chain[i]!.kind === 'condition' || chain[j]!.kind === 'condition') return g;
  const order = [...chain]; [order[i], order[j]] = [order[j]!, order[i]!];
  return { nodes: [...order, ...rest], edges: order.slice(1).map((n, k) => ({ from: order[k]!.id, to: n.id })).concat(g.edges.filter(e => rest.some(r => r.id === e.from || r.id === e.to))) };
}
