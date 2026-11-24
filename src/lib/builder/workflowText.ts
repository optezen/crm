// Plain-English wording for the workflow canvas: one place for node captions, the summary sentence and the problem list. Pure (testable without a browser).
import { ACTION_LABEL, OP_LABEL, TRIGGERS, type Action, type Condition } from '../automation/types.ts';
import { chainOf, graphToDefinition, nodeIssues, type Graph, type GraphNode, type Issue } from './workflowGraph.ts';

export type Who = (id: string) => string; export type Label = (path: string) => string;
const quote = (v: unknown) => `“${String(v)}”`;
/** {{lead.full_name}} is engine syntax; people see [Contact name]. */
export const humanize = (text: string, label: Label) => text.replace(/\{\{([a-z0-9_.-]{1,60})\}\}/g, (_, k: string) => `[${label(k)}]`);
const needsValue = (c: Condition) => c.op !== 'empty' && c.op !== 'not_empty';
const blank = (c: Condition) => needsValue(c) && String(c.value ?? '').trim() === '';

export function conditionText(c: Condition, label: Label): string { return `${label(c.field)} ${OP_LABEL[c.op]}${needsValue(c) ? (blank(c) ? ' (no value yet)' : ` ${quote(c.value)}`) : ''}`; }
const roleWord = (a: Extract<Action, { type: 'assign_round_robin' }>) => (a.roles ?? ['employee']).join(' / ');

/** Caption for a node: what a business owner would say, not the engine's vocabulary. */
export function describeStep(n: GraphNode, who: Who, label: Label): { kind: string; title: string; sub: string } {
  if (n.kind === 'trigger') { const t = TRIGGERS.find(x => x.event === n.event); return { kind: 'When this happens', title: t?.label ?? n.event, sub: n.object ? `in the “${n.object}” module` : 'This starts the automation' }; }
  if (n.kind === 'condition') return { kind: 'Only if', title: n.conditions.length ? n.conditions.map(c => conditionText(c, label)).join(n.op === 'or' ? ' or ' : ' and ') : 'Add a condition', sub: n.conditions.length > 1 ? (n.op === 'or' ? 'Any one is enough' : 'All must be true') : 'Otherwise nothing happens' };
  const a = n.action;
  if (a.type === 'wait') return { kind: 'Wait', title: a.minutes ? `Wait ${humanMinutes(a.minutes)}` : `Wait until ${label(a.until_field ?? '')}`, sub: 'Then continue with the next step' };
  const title = ACTION_LABEL[a.type].replace(' (round-robin)', '');
  const sub = a.type === 'create_task' ? `${quote(humanize(a.title, label))} · due in ${a.due_in_days} day${a.due_in_days === 1 ? '' : 's'}` : a.type === 'notify' ? `${a.recipient.length === 36 ? who(a.recipient) : a.recipient.replace('_', ' ')}: ${quote(humanize(a.title, label))}`
    : a.type === 'assign_lead' ? (a.user_id ? who(a.user_id) : 'Choose a person') : a.type === 'update_record' ? `${a.field || 'Choose a field'} → ${quote(a.value)}` : a.type === 'request_integration' ? `${a.channel}: ${quote(humanize(a.message, label))}`
    : a.type === 'assign_round_robin' ? `To the next ${roleWord(a)} in turn` : a.type === 'update_task_status' ? (a.status === 'done' ? 'Mark it done' : 'Reopen it') : '';
  return { kind: 'Then', title, sub };
}
export function humanMinutes(m: number): string { if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`; if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`; return `${m} minute${m === 1 ? '' : 's'}`; }

/** One action as a clause of a sentence ("assign the lead to the next employee in turn"). */
export function actionSentence(a: Action, who: Who, label: Label): string {
  const to = (r: string) => (r.length === 36 ? who(r) : r === 'lead_assignee' ? 'the lead’s assignee' : r === 'task_owner' ? 'the task owner' : r === 'event_actor' ? 'the person who triggered it' : r.replace('_', ' '));
  switch (a.type) {
    case 'assign_round_robin': return `assign the lead to the next ${roleWord(a)} in turn${a.only_if_unassigned === false ? '' : ' (only if it has no assignee yet)'}`;
    case 'assign_lead': return `assign the lead to ${a.user_id ? who(a.user_id) : '(nobody chosen yet)'}`;
    case 'create_task': return `create a follow-up task ${quote(humanize(a.title, label))}, due in ${a.due_in_days} day${a.due_in_days === 1 ? '' : 's'}, for ${to(a.owner)}`;
    case 'update_task_status': return a.status === 'done' ? `mark the task done (${quote(humanize(a.outcome ?? '', label))})` : 'reopen the task';
    case 'update_record': return `set ${a.field || '(no field chosen)'} to ${quote(humanize(String(a.value), label))}`;
    case 'notify': return `notify ${to(a.recipient)}: ${quote(humanize(a.title, label))}`;
    case 'wait': return a.minutes ? `wait ${humanMinutes(a.minutes)}` : `wait until ${label(a.until_field ?? '')}`;
    case 'request_integration': return `request a ${a.channel} message ${quote(humanize(a.message, label))} (recorded only until a ${a.channel} provider is connected)`;
  }
}

/** The automation as one plain sentence. Works on unfinished graphs too, so the owner sees what they have so far while problems are listed separately. */
export function summarize(g: Graph, who: Who, label: Label): { text: string; steps: string[] } | null {
  const { chain } = chainOf(g); const t = chain[0]; if (!t || t.kind !== 'trigger') return null;
  const trig = TRIGGERS.find(x => x.event === t.event); const when = (trig?.label ?? t.event).replace(/^An? /, 'a ');
  const cond = chain.find((n): n is Extract<GraphNode, { kind: 'condition' }> => n.kind === 'condition');
  const steps = chain.filter((n): n is Extract<GraphNode, { kind: 'action' | 'delay' }> => n.kind === 'action' || n.kind === 'delay').map(n => actionSentence(n.action, who, label));
  const head = `When ${when}${t.object ? ` in “${t.object}”` : ''}${cond && cond.conditions.length ? `, and only if ${cond.conditions.map(c => conditionText(c, label)).join(cond.op === 'or' ? ' or ' : ' and ')}` : ''}`;
  const body = steps.length ? steps.map((x, i) => (i === 0 ? x : x.startsWith('wait') ? `then ${x}` : `then ${x}`)).join(', ') : '';
  return { text: steps.length ? `${head}, Optizen will ${body}.` : `${head}, nothing is set to happen yet. Add an action.`, steps };
}

export type Problem = Issue & { fix?: string };
/** Everything wrong with the graph, most useful first. Grammar problems come from the real validator; blank condition values are an editor-level rule (the engine accepts an empty
 * text value, but nobody means "equals nothing": use "is empty" for that), so they block saving in the editor without changing what the engine accepts. */
export function problemsOf(g: Graph, label: Label): Problem[] {
  const c = graphToDefinition(g); const base: Problem[] = c.ok ? [] : [...c.issues];
  const blanks: Problem[] = [];
  for (const n of g.nodes) if (n.kind === 'condition') n.conditions.forEach((cd, i) => { if (blank(cd)) blanks.push({ nodeId: n.id, message: `Condition ${i + 1} (${label(cd.field)} ${OP_LABEL[cd.op]}) needs a value.`, fix: 'Type the value to compare with, or choose “is empty” to test for a blank field.' }); });
  const blanked = new Set(blanks.map(b => b.nodeId));
  const per = nodeIssues(g);
  const seen = new Set(base.map(b => `${b.nodeId}|${b.message}`));
  const extra = c.ok ? [] : Object.entries(per).filter(([id, m]) => !seen.has(`${id}|${m}`)).map(([nodeId, message]) => ({ nodeId, message }));
  return [...blanks, ...[...base, ...extra].filter(p => !(p.nodeId && blanked.has(p.nodeId)))];
}
/** The first problem per step, for the badge on the node. */
export const issueMap = (ps: Problem[]): Record<string, string> => { const m: Record<string, string> = {}; for (const p of ps) if (p.nodeId && !m[p.nodeId]) m[p.nodeId] = p.message; return m; };
