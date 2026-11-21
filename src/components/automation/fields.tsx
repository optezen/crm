'use client';
// Property editors shared by the visual canvas and the list editor, so both edit the same validated action/condition shapes.
import { ACTION_LABEL, APPOINTMENT_FIELDS, CHANNELS, CONDITION_OPS, INVENTORY_FIELDS, INVOICE_FIELDS, LEAD_FIELDS, OP_LABEL, PAYMENT_FIELDS, RR_ROLES, TASK_FIELDS, type Action, type Condition, type Scope } from '../../lib/automation/types';

export type ModuleOption = { key: string; label: string; fields: { key: string; label: string }[] };
export type MemberOption = { id: string; email: string; role: string; active: boolean };
type Opt = readonly (readonly [string, string])[];

/** Fields a trigger exposes to conditions, templates and "wait until". */
export function fieldOptionsFor(scope: Scope, object: string | undefined, modules: ModuleOption[]): Opt {
  return scope === 'record' ? (modules.find(m => m.key === object)?.fields ?? modules.flatMap(m => m.fields)).map(f => [`record.${f.key}`, f.label] as const)
    : scope === 'task' ? [...TASK_FIELDS, ...LEAD_FIELDS] : scope === 'lead' ? [...LEAD_FIELDS] : scope === 'appointment' ? [...APPOINTMENT_FIELDS] : scope === 'inventory' ? [...INVENTORY_FIELDS]
    : scope === 'invoice' ? [...INVOICE_FIELDS] : scope === 'payment' ? [...PAYMENT_FIELDS, ...INVOICE_FIELDS] : [];
}

export function ConditionsEditor({ op, conditions, onChange, fieldOptions }: { op: 'and' | 'or'; conditions: Condition[]; onChange: (op: 'and' | 'or', c: Condition[]) => void; fieldOptions: Opt }) {
  const setCond = (i: number, c: Partial<Condition>) => onChange(op, conditions.map((x, j) => (j === i ? { ...x, ...c } : x)));
  return <div className="stack" style={{ gap: 10 }}>
    {conditions.length > 1 && <div className="field" style={{ maxWidth: 260 }}><label htmlFor="mop">Combine with</label><select id="mop" className="input" value={op} onChange={e => onChange(e.target.value as 'and' | 'or', conditions)}><option value="and">ALL must match (AND)</option><option value="or">ANY can match (OR)</option></select></div>}
    {conditions.map((c, i) => <div className="inline" key={i}>
      <select className="input" aria-label={`Condition ${i + 1} field`} value={c.field} onChange={e => setCond(i, { field: e.target.value })}>{!fieldOptions.some(([k]) => k === c.field) && <option value={c.field}>{c.field || 'Choose a field…'}</option>}{fieldOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <select className="input" aria-label={`Condition ${i + 1} comparison`} value={c.op} onChange={e => { const o = e.target.value as Condition['op']; const { value, ...rest } = c; onChange(op, conditions.map((x, j) => (j === i ? (o === 'empty' || o === 'not_empty' ? { ...rest, op: o } : { ...rest, op: o, value: value ?? '' }) : x))); }}>{CONDITION_OPS.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
      {c.op !== 'empty' && c.op !== 'not_empty' && <input className="input" aria-label={`Condition ${i + 1} value`} value={String(c.value ?? '')} placeholder={c.op === 'before' || c.op === 'after' ? 'YYYY-MM-DD or today' : 'Value'} onChange={e => setCond(i, { value: e.target.value })} />}
      <button type="button" className="btn" onClick={() => onChange(op, conditions.filter((_, j) => j !== i))}>Remove</button>
    </div>)}
    <div><button type="button" className="btn" disabled={conditions.length >= 20 || fieldOptions.length === 0} onClick={() => onChange(op, [...conditions, { field: fieldOptions[0]![0], op: 'eq', value: '' }])}>Add a condition</button></div>
  </div>;
}

export function ActionFields({ a, onChange, scope, object, modules, members, fieldOptions }: { a: Action; onChange: (a: Action) => void; scope: Scope; object?: string; modules: ModuleOption[]; members: MemberOption[]; fieldOptions: Opt }) {
  const leadish = scope === 'lead' || scope === 'task'; const memberChoices = members.filter(m => m.active);
  const numField = (v: number | undefined, on: (n: number) => void, label: string, max: number) => <input className="input" type="number" min={0} max={max} style={{ width: 90 }} aria-label={label} value={v ?? ''} onChange={e => on(Number(e.target.value))} />;
  const memberSelect = (v: string, on: (v: string) => void, label: string, extra: [string, string][] = []) => <select className="input" aria-label={label} value={v} onChange={e => on(e.target.value)}>
    {v === '' && <option value="">Choose…</option>}{extra.map(([k, l]) => <option key={k} value={k}>{l}</option>)}{memberChoices.map(m => <option key={m.id} value={m.id}>{m.email} ({m.role})</option>)}</select>;
  return <>
    <div className="inline">
      {a.type === 'assign_round_robin' && <>
        {RR_ROLES.map(r => <label key={r} className="row" style={{ gap: 6 }}><input type="checkbox" checked={(a.roles ?? ['employee']).includes(r)} onChange={e => { const cur = a.roles ?? ['employee']; const roles = e.target.checked ? [...cur, r] : cur.filter(x => x !== r); onChange({ ...a, roles: roles.length ? roles : cur }); }} /> {r}s</label>)}
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={a.only_if_unassigned !== false} onChange={e => onChange({ ...a, only_if_unassigned: e.target.checked })} /> Only if the lead has no assignee</label></>}
      {a.type === 'assign_lead' && memberSelect(a.user_id, v => onChange({ ...a, user_id: v }), 'Assignee')}
      {a.type === 'create_task' && <>
        <div className="field"><input className="input" aria-label="Task title" value={a.title} maxLength={200} onChange={e => onChange({ ...a, title: e.target.value })} /></div>
        <span>due in</span>{numField(a.due_in_days, n => onChange({ ...a, due_in_days: n }), 'Days until due', 365)}<span>day(s), for</span>
        {memberSelect(a.owner, v => onChange({ ...a, owner: v }), 'Task owner', [['lead_assignee', 'The lead’s assignee']])}</>}
      {a.type === 'update_task_status' && <><select className="input" aria-label="New status" value={a.status} onChange={e => onChange(e.target.value === 'done' ? { type: 'update_task_status', status: 'done', outcome: a.outcome ?? 'Completed automatically' } : { type: 'update_task_status', status: 'open' })}><option value="done">Done</option><option value="open">Open</option></select>
        {a.status === 'done' && <div className="field"><input className="input" aria-label="Outcome" value={a.outcome ?? ''} onChange={e => onChange({ ...a, outcome: e.target.value })} /></div>}</>}
      {a.type === 'update_record' && <>
        <select className="input" aria-label="Field to update" value={a.field} onChange={e => onChange({ ...a, field: e.target.value })}><option value="">Choose a field…</option>{(modules.find(m => m.key === object)?.fields ?? []).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        <span>to</span><div className="field"><input className="input" aria-label="New value" value={String(a.value)} onChange={e => onChange({ ...a, value: e.target.value })} /></div></>}
      {a.type === 'notify' && <>
        {memberSelect(a.recipient, v => onChange({ ...a, recipient: v }), 'Who to notify', [['event_actor', 'The person who triggered it'], ...(leadish ? [['lead_assignee', 'The lead’s assignee'] as [string, string]] : []), ...(scope === 'task' ? [['task_owner', 'The task owner'] as [string, string]] : [])])}
        <div className="field"><input className="input" aria-label="Notification title" placeholder="Title" value={a.title} maxLength={120} onChange={e => onChange({ ...a, title: e.target.value })} /></div>
        <div className="field"><input className="input" aria-label="Notification details" placeholder="Details (optional)" value={a.body ?? ''} maxLength={500} onChange={e => onChange({ ...a, body: e.target.value || undefined })} /></div></>}
      {a.type === 'wait' && <>
        <select className="input" aria-label="Wait mode" value={a.minutes !== undefined ? 'minutes' : 'field'} onChange={e => onChange(e.target.value === 'minutes' ? { type: 'wait', minutes: 60 } : { type: 'wait', until_field: fieldOptions[0]?.[0] ?? '' })}><option value="minutes">For a delay</option><option value="field" disabled={fieldOptions.length === 0}>Until a date field</option></select>
        {a.minutes !== undefined ? <>{numField(a.minutes, n => onChange({ ...a, minutes: n }), 'Minutes to wait', 525600)}<span>minutes</span></> : <select className="input" aria-label="Date field" value={a.until_field} onChange={e => onChange({ type: 'wait', until_field: e.target.value })}>{fieldOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</>}
      {a.type === 'request_integration' && <>
        <select className="input" aria-label="Channel" value={a.channel} onChange={e => onChange({ ...a, channel: e.target.value, ...(e.target.value === 'webhook' ? {} : { to: 'lead_contact' as const }) })}>{CHANNELS.map(c => <option key={c}>{c}</option>)}</select>
        <div className="field"><input className="input" aria-label="Message" value={a.message} maxLength={1000} onChange={e => onChange({ ...a, message: e.target.value })} /></div></>}
    </div>
    {a.type === 'request_integration' && <p className="muted">No messaging provider is connected. This only records a request; nothing is sent until a provider is connected for this channel.</p>}
    {a.type === 'wait' && <p className="muted">The delay is stored in the database and survives restarts. The next steps run after it, even if nobody has the app open.</p>}
  </>;
}
export { ACTION_LABEL };
