// Safe preview ("dry run") of an automation against sample data. PURE: no database, no network, no server actions, so it cannot write anything.
// Condition and template semantics mirror public.automation_cond / automation_eval / automation_tpl (migration 0007); tests/automation-preview.test.mjs runs one corpus
// through this file and the real SQL functions. The real engine remains the only thing that decides what actually happens when an automation runs.
// ponytail: numbers compare as JS doubles (SQL uses numeric, up to 30 digits); exact for the values a business form produces, upgrade to a decimal lib if that ever matters.
import { ACTION_LABEL, OP_LABEL, TRIGGERS, type Action, type AutomationDefinition, type Condition, type Match } from './types.ts';

export type Sample = Record<string, string>; // dotted path ("lead.full_name") -> text, like the engine's event snapshot
const get = (s: Sample, path: string): string | null => (path in s && s[path] !== undefined ? s[path]! : null);
const NUM = /^-?[0-9]{1,30}(\.[0-9]{1,15})?$/;
const num = (p: string | null) => (p !== null && NUM.test(p) ? Number(p) : null);
function date(p: string | null, today: string): string | null {
  if (p === null) return null; if (p.trim().toLowerCase() === 'today') return today;
  if (!/^\d{4}-\d{2}-\d{2}/.test(p)) return null; const d = p.slice(0, 10), t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}
const valueText = (v: Condition['value']) => (v === undefined || v === null ? null : typeof v === 'string' ? v : String(v));

export function evalCondition(c: Condition, s: Sample, today: string): boolean {
  const a = get(s, c.field), b = valueText(c.value);
  switch (c.op) {
    case 'empty': return a === null || a.trim() === '';
    case 'not_empty': return a !== null && a.trim() !== '';
    case 'eq': case 'neq': { const x = num(a), y = num(b); return (x !== null && y !== null ? x === y : a === b) === (c.op === 'eq'); }
    case 'contains': return a !== null && b !== null && a.toLowerCase().includes(b.toLowerCase());
    case 'gt': { const x = num(a), y = num(b); return x !== null && y !== null && x > y; }
    case 'lt': { const x = num(a), y = num(b); return x !== null && y !== null && x < y; }
    case 'before': { const x = date(a, today), y = date(b, today); return x !== null && y !== null && x < y; }
    case 'after': { const x = date(a, today), y = date(b, today); return x !== null && y !== null && x > y; }
    default: return false;
  }
}
export const evalMatch = (m: Match | undefined, s: Sample, today: string) => !m || m.conditions.length === 0 || (m.op === 'or' ? m.conditions.some(c => evalCondition(c, s, today)) : m.conditions.every(c => evalCondition(c, s, today)));
export const renderTemplate = (text: string, s: Sample) => text.replace(/\{\{([a-z0-9_.-]{1,60})\}\}/g, (_, k: string) => (get(s, k) ?? '').slice(0, 500));

/** Believable sample values so a preview runs out of the box; the user can edit every one to try other cases. */
const DEFAULTS: Record<string, string> = {
  'lead.stage': 'New', 'lead.source': 'website', 'lead.summary': 'Interested in a quote', 'lead.assigned_to': '', 'lead.full_name': 'Asha Patel', 'lead.phone': '+91 98765 43210', 'lead.email': 'asha@example.com', 'lead.created_at': '{today}',
  'task.title': 'Call about the quote', 'task.status': 'open', 'task.owner_id': '', 'task.due_date': '{today}', 'task.outcome': '',
  'appointment.status': 'booked', 'appointment.type': 'Consultation', 'appointment.reschedule_count': '0', 'inventory.name': 'Sample product', 'inventory.on_hand': '4', 'inventory.threshold': '5', 'inventory.quantity': '2',
  'invoice.number': 'INV-0001', 'invoice.status': 'issued', 'invoice.currency': 'INR', 'invoice.total': '1200', 'invoice.balance_due': '1200', 'payment.amount': '500', 'payment.method': 'cash', 'payment.source': 'manual',
};
export const sampleFor = (fields: readonly (readonly [string, string])[], today: string): Sample => Object.fromEntries(fields.map(([k]) => [k, (DEFAULTS[k] ?? (k.startsWith('record.') ? 'Sample value' : '')).replace('{today}', today)]));

export type PreviewStep = { kind: 'trigger' | 'condition' | 'action' | 'wait'; title: string; detail: string; outcome: 'happens' | 'stops' | 'skipped' | 'waits' };
export type Preview = { matched: boolean; steps: PreviewStep[]; headline: string };
const addDays = (today: string, n: number) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** What would happen if this exact event occurred. Nothing is executed. `label` turns a field path into the name a person sees. */
export function preview(def: AutomationDefinition, s: Sample, o: { today: string; who: (id: string) => string; label: (path: string) => string }): Preview {
  const t = TRIGGERS.find(x => x.event === def.trigger.event);
  const steps: PreviewStep[] = [{ kind: 'trigger', title: t?.label ?? def.trigger.event, detail: 'The sample event below is treated as if it just happened.', outcome: 'happens' }];
  const conds = def.match?.conditions ?? [];
  const matched = evalMatch(def.match, s, o.today);
  if (conds.length) {
    const rows = conds.map(c => ({ c, ok: evalCondition(c, s, o.today) }));
    steps.push({ kind: 'condition', title: matched ? 'The conditions are met' : 'The conditions are not met', outcome: matched ? 'happens' : 'stops',
      detail: rows.map(r => `${r.ok ? '✓' : '✗'} ${o.label(r.c.field)} ${OP_LABEL[r.c.op]}${r.c.value === undefined ? '' : ` “${r.c.value}”`} (sample: ${get(s, r.c.field) || 'empty'})`).join('\n') + (conds.length > 1 ? `\n${def.match?.op === 'or' ? 'Any one is enough.' : 'All must be true.'}` : '') + (matched ? '' : '\nSo this automation would stop here and do nothing.') });
  }
  def.actions.forEach((a, i) => {
    if (!matched) { steps.push({ kind: a.type === 'wait' ? 'wait' : 'action', title: ACTION_LABEL[a.type], detail: 'Not reached.', outcome: 'skipped' }); return; }
    steps.push(describeAction(a, i, s, o));
  });
  const done = steps.filter(x => x.kind !== 'trigger' && x.kind !== 'condition' && x.outcome === 'happens').length;
  return { matched, steps, headline: matched ? `This would run. ${done} action${done === 1 ? '' : 's'} would happen${def.actions.some(a => a.type === 'wait') ? ', some after a delay' : ''}. Nothing was changed or sent.` : 'This would not run for that sample, so nothing would happen. Nothing was changed or sent.' };
}

function describeAction(a: Action, _i: number, s: Sample, o: { today: string; who: (id: string) => string }): PreviewStep {
  const step = (title: string, detail: string, outcome: PreviewStep['outcome'] = 'happens', kind: PreviewStep['kind'] = 'action'): PreviewStep => ({ kind, title, detail, outcome });
  switch (a.type) {
    case 'assign_round_robin': return (a.only_if_unassigned !== false && (get(s, 'lead.assigned_to') ?? '').trim() !== '')
      ? step('Assign the lead in rotation', 'Skipped: this lead already has an assignee and the step is set to assign only when there is none.', 'skipped')
      : step('Assign the lead in rotation', `The next active ${(a.roles ?? ['employee']).join(' / ')} in the rotation would be chosen. Preview does not move the rotation.`);
    case 'assign_lead': return step('Assign the lead to a person', `The lead would be assigned to ${a.user_id ? o.who(a.user_id) : '(nobody chosen yet)'}.`);
    case 'create_task': return step('Create a follow-up task', `“${renderTemplate(a.title, s)}” would be created, due ${addDays(o.today, a.due_in_days)} (${a.due_in_days === 0 ? 'today' : `in ${a.due_in_days} day${a.due_in_days === 1 ? '' : 's'}`}), for ${a.owner === 'lead_assignee' ? 'the lead’s assignee' : o.who(a.owner)}.`);
    case 'update_task_status': return step('Update the task', a.status === 'done' ? `The task would be marked done with the outcome “${renderTemplate(a.outcome ?? '', s)}”.` : 'The task would be reopened.');
    case 'update_record': return step('Update the record', `${a.field || '(no field chosen)'} would be set to “${renderTemplate(String(a.value), s)}”.`);
    case 'notify': return step('Notify a team member in Optizen', `${a.recipient.length === 36 ? o.who(a.recipient) : a.recipient.replace('_', ' ')} would see: “${renderTemplate(a.title, s)}”.`);
    case 'wait': return step('Wait', a.minutes ? `The automation would pause for ${a.minutes} minute${a.minutes === 1 ? '' : 's'}, then continue with the next step. Preview does not wait.` : `The automation would pause until ${a.until_field}, then continue.`, 'waits', 'wait');
    case 'request_integration': return step('Request an external message', `A ${a.channel} message request “${renderTemplate(a.message, s)}” would be recorded. Nothing is sent until a ${a.channel} provider is connected, and never from a preview.`);
  }
}
