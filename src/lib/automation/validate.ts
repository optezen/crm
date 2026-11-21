// TypeScript mirror of public.automation_validate (migration 0007). The database is the real gate; a parity test runs one corpus through both.
import { ACTION_TYPES, CHANNELS, CONDITION_OPS, RR_ROLES, TRIGGERS, scopeOf, type AutomationDefinition, type Result, type Scope } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOk = (v: unknown, allowed: string[]) => isObj(v) && Object.keys(v).every(k => allowed.includes(k));
const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const num = (s: string) => /^-?[0-9]{1,30}(\.[0-9]{1,15})?$/.test(s);
const dateOk = (s: string) => { if (s.trim().toLowerCase() === 'today') return true; if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false; const d = new Date(s.slice(0, 10) + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s.slice(0, 10); };
export const pathOk = (path: unknown, scope: Scope) => typeof path === 'string' && /^(lead|task|record|appointment|inventory|invoice|payment)\.[a-z][a-z0-9_]{0,39}$/.test(path) &&
  ((path.startsWith('lead.') && (scope === 'lead' || scope === 'task')) || (path.startsWith('task.') && scope === 'task') || (path.startsWith('record.') && scope === 'record')
    || (path.startsWith('appointment.') && scope === 'appointment') || (path.startsWith('inventory.') && scope === 'inventory') || (path.startsWith('invoice.') && (scope === 'invoice' || scope === 'payment')) || (path.startsWith('payment.') && scope === 'payment'));
const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const asText = (v: unknown) => String(v);

export function validateAutomation(raw: unknown): Result<AutomationDefinition> {
  const bad = (error: string): Result<AutomationDefinition> => ({ ok: false, error });
  if (!isObj(raw) || JSON.stringify(raw).length > 30000 || !keysOk(raw, ['trigger', 'match', 'actions'])) return bad('The automation definition is invalid.');
  const t = raw.trigger;
  if (!keysOk(t, ['event', 'object']) || !TRIGGERS.some(x => x.event === (t as Record<string, unknown>).event)) return bad('Choose a trigger.');
  const trig = t as { event: string; object?: unknown }; const scope = scopeOf(trig.event);
  if ('object' in trig && (scope !== 'record' || typeof trig.object !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trig.object) || trig.object.length > 40)) return bad('Only record triggers can be limited to a module.');
  if ('match' in raw) {
    const m = raw.match as Record<string, unknown>;
    const conds = isObj(m) ? (m.conditions ?? []) : null;
    if (!keysOk(m, ['op', 'conditions']) || !['and', 'or'].includes(String(m.op ?? 'and')) || !Array.isArray(conds) || conds.length > 20) return bad('The conditions are invalid (at most 20, combined with and/or).');
    for (const c of conds as unknown[]) {
      if (!keysOk(c, ['field', 'op', 'value']) || !pathOk((c as Record<string, unknown>).field, scope)) return bad('A condition refers to a field that this trigger does not provide.');
      const { op, value } = c as Record<string, unknown>;
      if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) return bad('A condition has an unknown comparison.');
      if (op === 'empty' || op === 'not_empty') { if ('value' in (c as object)) return bad('Empty / not empty conditions take no value.'); continue; }
      if (!scalar(value) || asText(value).length > 200) return bad('Every condition needs a value of up to 200 characters.');
      if ((op === 'gt' || op === 'lt') && !num(asText(value))) return bad('Greater / less than needs a number.');
      if ((op === 'before' || op === 'after') && !dateOk(asText(value))) return bad('Before / after needs a date (YYYY-MM-DD) or "today".');
    }
  }
  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 10) return bad('Add between 1 and 10 actions.');
  for (const [i, a] of (raw.actions as unknown[]).entries()) {
    const n = i + 1; const A = a as Record<string, unknown>; const type = isObj(a) && typeof A.type === 'string' ? A.type : null;
    if (!type) return bad(`Action ${n} is invalid.`);
    if (!(ACTION_TYPES as readonly string[]).includes(type)) return bad(`Action ${n} has an unknown type.`);
    const leadish = scope === 'lead' || scope === 'task'; let ok = false;
    switch (type) {
      case 'update_record': ok = scope === 'record' && keysOk(A, ['type', 'field', 'value']) && /^[a-z][a-z0-9_]{0,39}$/.test(String(A.field ?? '')) && scalar(A.value) && asText(A.value).length <= 1000; break;
      case 'assign_lead': ok = leadish && keysOk(A, ['type', 'user_id']) && UUID.test(String(A.user_id ?? '')); break;
      case 'assign_round_robin': ok = leadish && keysOk(A, ['type', 'roles', 'only_if_unassigned']) && (!('only_if_unassigned' in A) || typeof A.only_if_unassigned === 'boolean') &&
        (!('roles' in A) || (Array.isArray(A.roles) && A.roles.length >= 1 && A.roles.length <= 3 && A.roles.every(r => (RR_ROLES as readonly unknown[]).includes(r)))); break;
      case 'create_task': ok = leadish && keysOk(A, ['type', 'title', 'due_in_days', 'owner']) && str(A.title, 1, 200) && typeof A.due_in_days === 'number' && Number.isInteger(A.due_in_days) && A.due_in_days >= 0 && A.due_in_days <= 365 &&
        (A.owner === 'lead_assignee' || UUID.test(String(A.owner ?? ''))); break;
      case 'update_task_status': ok = scope === 'task' && keysOk(A, ['type', 'status', 'outcome']) && (A.status === 'open' ? !('outcome' in A) : A.status === 'done' && str(A.outcome, 1, 1000)); break;
      case 'notify': { const r = String(A.recipient ?? '');
        ok = keysOk(A, ['type', 'recipient', 'title', 'body']) && /^(lead_assignee|task_owner|event_actor|[0-9a-f-]{36})$/.test(r) && (r.length !== 36 || UUID.test(r)) && !(r === 'lead_assignee' && !leadish) && !(r === 'task_owner' && scope !== 'task') &&
          str(A.title, 1, 120) && (!('body' in A) || (typeof A.body === 'string' && A.body.length <= 500)); break; }
      case 'wait': ok = keysOk(A, ['type', 'minutes', 'until_field']) && ('minutes' in A) !== ('until_field' in A) &&
        (!('minutes' in A) || (typeof A.minutes === 'number' && Number.isInteger(A.minutes) && A.minutes >= 1 && A.minutes <= 525600)) && (!('until_field' in A) || pathOk(A.until_field, scope)); break;
      case 'request_integration': ok = keysOk(A, ['type', 'channel', 'message', 'to']) && (CHANNELS as readonly unknown[]).includes(A.channel) && str(A.message, 1, 1000) &&
        (!('to' in A) || (A.to === 'lead_contact' && leadish)) && !(['whatsapp', 'sms', 'email'].includes(String(A.channel)) && !('to' in A)); break;
    }
    if (!ok) return bad(`Action ${n} is not valid for this trigger. Check its fields.`);
  }
  return { ok: true, value: raw as unknown as AutomationDefinition };
}

/** Plain-language preview of a definition. */
export function describeAutomation(d: AutomationDefinition, who: (id: string) => string = id => id.slice(0, 8)): string[] {
  const trig = TRIGGERS.find(t => t.event === d.trigger.event);
  const lines = [`When ${(trig?.label ?? d.trigger.event).replace(/^An? /, 'a ')}${d.trigger.object ? ` in “${d.trigger.object}”` : ''}`];
  const cs = d.match?.conditions ?? [];
  if (cs.length) lines.push(`Only if ${cs.map(c => `${c.field} ${c.op.replace('_', ' ')}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ''}`).join(d.match?.op === 'or' ? ' OR ' : ' AND ')}`);
  d.actions.forEach((a, i) => {
    const n = `${i + 1}. `;
    switch (a.type) {
      case 'assign_round_robin': lines.push(`${n}Assign the lead to the next active ${(a.roles ?? ['employee']).join('/')} in rotation${a.only_if_unassigned === false ? '' : ' (only if it has no assignee)'}`); break;
      case 'assign_lead': lines.push(`${n}Assign the lead to ${who(a.user_id)}`); break;
      case 'create_task': lines.push(`${n}Create task “${a.title}” for ${a.owner === 'lead_assignee' ? 'the lead’s assignee' : who(a.owner)}, due in ${a.due_in_days} day${a.due_in_days === 1 ? '' : 's'}`); break;
      case 'update_task_status': lines.push(`${n}Mark the task ${a.status === 'done' ? `done (“${a.outcome}”)` : 'open again'}`); break;
      case 'update_record': lines.push(`${n}Set ${a.field} to ${JSON.stringify(a.value)} on the record`); break;
      case 'notify': lines.push(`${n}Notify ${a.recipient.length === 36 ? who(a.recipient) : a.recipient.replace('_', ' ')}: “${a.title}”`); break;
      case 'wait': lines.push(a.minutes ? `${n}Wait ${a.minutes} minute${a.minutes === 1 ? '' : 's'}, then continue` : `${n}Wait until ${a.until_field}, then continue`); break;
      case 'request_integration': lines.push(`${n}Request a ${a.channel} message (recorded only; it is sent once a ${a.channel} provider is connected)`); break;
    }
  });
  return lines;
}
