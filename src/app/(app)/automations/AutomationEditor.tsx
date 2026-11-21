'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABEL, ACTION_TYPES, APPOINTMENT_FIELDS, CHANNELS, CONDITION_OPS, INVENTORY_FIELDS, INVOICE_FIELDS, LEAD_FIELDS, OP_LABEL, PAYMENT_FIELDS, RR_ROLES, TASK_FIELDS, TRIGGERS, scopeOf, type Action, type ActionType, type AutomationDefinition, type Condition } from '../../../lib/automation/types';
import { describeAutomation, validateAutomation } from '../../../lib/automation/validate';
import { Card } from '../../../components/ui/Card';
import { discardAutomationDraftAction, publishAutomationAction, saveAutomationAction, setEnabledAction, type AutoResult } from './actions';

export type ModuleOption = { key: string; label: string; fields: { key: string; label: string }[] };
export type MemberOption = { id: string; email: string; role: string; active: boolean };
const blank = (a: ActionType): Action => ({
  assign_round_robin: { type: 'assign_round_robin' }, assign_lead: { type: 'assign_lead', user_id: '' }, create_task: { type: 'create_task', title: 'Follow up with {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' },
  update_task_status: { type: 'update_task_status', status: 'done', outcome: 'Completed automatically' }, update_record: { type: 'update_record', field: '', value: '' }, notify: { type: 'notify', recipient: 'event_actor', title: '' },
  wait: { type: 'wait', minutes: 60 }, request_integration: { type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}' },
} as Record<ActionType, Action>)[a];
const norm = (d: AutomationDefinition, name: string) => JSON.stringify([name, d]);
const START: AutomationDefinition = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };

export function AutomationEditor({ id, name: initName, enabled, publishedVersion, draft, published, modules, members }: { id: string | null; name: string; enabled: boolean; publishedVersion: number | null; draft: AutomationDefinition | null; published: AutomationDefinition | null; modules: ModuleOption[]; members: MemberOption[] }) {
  const router = useRouter();
  const [name, setName] = useState(initName || 'New lead follow-up');
  const [def, setDef] = useState<AutomationDefinition>(draft ?? published ?? START);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [pending, start] = useTransition();
  const scope = scopeOf(def.trigger.event);
  const conds = def.match?.conditions ?? [];
  const valid = useMemo(() => validateAutomation(def), [def]);
  const saved = draft ?? published;
  const dirty = !saved || norm(def, name) !== norm(saved, initName);
  const who = (uid: string) => members.find(m => m.id === uid)?.email ?? uid.slice(0, 8);
  const fieldOptions: (readonly [string, string])[] = scope === 'record' ? (modules.find(m => m.key === def.trigger.object)?.fields ?? modules.flatMap(m => m.fields)).map(f => [`record.${f.key}`, f.label]) : scope === 'task' ? [...TASK_FIELDS, ...LEAD_FIELDS] : scope === 'lead' ? [...LEAD_FIELDS] : scope === 'appointment' ? [...APPOINTMENT_FIELDS] : scope === 'inventory' ? [...INVENTORY_FIELDS] : scope === 'invoice' ? [...INVOICE_FIELDS] : scope === 'payment' ? [...PAYMENT_FIELDS, ...INVOICE_FIELDS] : [];
  const memberChoices = members.filter(m => m.active);
  const set = (patch: Partial<AutomationDefinition>) => setDef(d => ({ ...d, ...patch }));
  const setCond = (i: number, c: Partial<Condition>) => set({ match: { op: def.match?.op ?? 'and', conditions: conds.map((x, j) => (j === i ? { ...x, ...c } : x)) } });
  const setAct = (i: number, a: Action) => set({ actions: def.actions.map((x, j) => (j === i ? a : x)) });
  const move = (i: number, d: number) => { const s = [...def.actions]; const j = i + d; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j]!, s[i]!]; set({ actions: s }); };
  const changeTrigger = (event: string) => {
    const sc = scopeOf(event);
    const actions: Action[] = sc === 'lead' || sc === 'task' ? START.actions : [{ type: 'notify', recipient: 'event_actor', title: 'Something happened' }];
    setDef({ trigger: { event, ...(sc === 'record' && modules[0] ? { object: modules[0].key } : {}) }, actions });
  };
  const run = (fn: () => Promise<AutoResult>, after?: (r: Extract<AutoResult, { ok: true }>) => void) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { after?.(r); router.refresh(); } });
  const save = () => run(() => saveAutomationAction(id, name, def), r => { if (!id && r.id) router.replace(`/automations/${r.id}`); });
  const numField = (v: number | undefined, on: (n: number) => void, label: string, max: number) => <input className="input" type="number" min={0} max={max} style={{ width: 90 }} aria-label={label} value={v ?? ''} onChange={e => on(Number(e.target.value))} />;
  const memberSelect = (v: string, on: (v: string) => void, label: string, extra: [string, string][] = []) => <select className="input" aria-label={label} value={v} onChange={e => on(e.target.value)}>
    {v === '' && <option value="">Choose…</option>}{extra.map(([k, l]) => <option key={k} value={k}>{l}</option>)}{memberChoices.map(m => <option key={m.id} value={m.id}>{m.email} ({m.role})</option>)}</select>;
  const leadish = scope === 'lead' || scope === 'task';
  const available = ACTION_TYPES.filter(a => (a === 'assign_round_robin' || a === 'assign_lead' || a === 'create_task') ? leadish : a === 'update_task_status' ? scope === 'task' : a === 'update_record' ? scope === 'record' : a === 'request_integration' ? true : true);
  const trig = TRIGGERS.find(t => t.event === def.trigger.event);
  const [adding, setAdding] = useState<ActionType>('notify');

  return <div className="stack">
    <Card title="Name and trigger" description="An automation runs in the background whenever its trigger happens in this workspace.">
      <div className="stack">
        <div className="field"><label htmlFor="aname">Name</label><input id="aname" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
        <div className="inline">
          <div className="field"><label htmlFor="trig">When</label><select id="trig" className="input" value={def.trigger.event} onChange={e => changeTrigger(e.target.value)}>{TRIGGERS.map(t => <option key={t.event} value={t.event}>{t.label}</option>)}</select></div>
          {scope === 'record' && <div className="field"><label htmlFor="mod">In module</label><select id="mod" className="input" value={def.trigger.object ?? ''} onChange={e => setDef({ ...def, trigger: { event: def.trigger.event, ...(e.target.value ? { object: e.target.value } : {}) }, match: undefined })}>
            <option value="">Any module</option>{modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select></div>}
        </div>
        {trig && 'module' in trig && <p className="muted">This trigger needs the {trig.module} module to be enabled in the Builder before the automation can be published.</p>}
        {scope === 'record' && modules.length === 0 && <p className="muted">Create a custom module in the Builder first.</p>}
      </div>
    </Card>

    <Card title="Conditions" description={scope === 'none' ? 'This trigger has no data to test yet.' : 'Optional. The automation only runs when these match the data at the time of the event.'}>
      <div className="stack" style={{ gap: 10 }}>
        {conds.length > 1 && <div className="field" style={{ maxWidth: 260 }}><label htmlFor="mop">Combine with</label><select id="mop" className="input" value={def.match?.op ?? 'and'} onChange={e => set({ match: { op: e.target.value as 'and' | 'or', conditions: conds } })}><option value="and">ALL must match (AND)</option><option value="or">ANY can match (OR)</option></select></div>}
        {conds.map((c, i) => <div className="inline" key={i}>
          <select className="input" aria-label={`Condition ${i + 1} field`} value={c.field} onChange={e => setCond(i, { field: e.target.value })}>{!fieldOptions.some(([k]) => k === c.field) && <option value={c.field}>{c.field || 'Choose a field…'}</option>}{fieldOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="input" aria-label={`Condition ${i + 1} comparison`} value={c.op} onChange={e => { const op = e.target.value as Condition['op']; const { value, ...rest } = c; set({ match: { op: def.match?.op ?? 'and', conditions: conds.map((x, j) => (j === i ? (op === 'empty' || op === 'not_empty' ? { ...rest, op } : { ...rest, op, value: value ?? '' }) : x)) } }); }}>{CONDITION_OPS.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
          {c.op !== 'empty' && c.op !== 'not_empty' && <input className="input" aria-label={`Condition ${i + 1} value`} value={String(c.value ?? '')} placeholder={c.op === 'before' || c.op === 'after' ? 'YYYY-MM-DD or today' : 'Value'} onChange={e => setCond(i, { value: e.target.value })} />}
          <button type="button" className="btn" onClick={() => set({ match: { op: def.match?.op ?? 'and', conditions: conds.filter((_, j) => j !== i) } })}>Remove</button>
        </div>)}
        <div><button type="button" className="btn" disabled={conds.length >= 20 || fieldOptions.length === 0} onClick={() => set({ match: { op: def.match?.op ?? 'and', conditions: [...conds, { field: fieldOptions[0]![0], op: 'eq', value: '' }] } })}>Add a condition</button></div>
      </div>
    </Card>

    <Card title="Actions" description="Run in order. Each action is a fixed, validated operation; nothing here can run code or SQL. Use {{lead.full_name}} style placeholders in text.">
      <div className="stack" style={{ gap: 12 }}>
        {def.actions.map((a, i) => <div key={i} className="stack" style={{ gap: 8, borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 12 : 0 }}>
          <div className="row"><strong>{i + 1}. {ACTION_LABEL[a.type]}</strong>
            <button type="button" className="btn" aria-label={`Move action ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="btn" aria-label={`Move action ${i + 1} down`} disabled={i === def.actions.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="btn" disabled={def.actions.length <= 1} onClick={() => set({ actions: def.actions.filter((_, j) => j !== i) })}>Remove</button></div>
          <div className="inline">
            {a.type === 'assign_round_robin' && <>
              {RR_ROLES.map(r => <label key={r} className="row" style={{ gap: 6 }}><input type="checkbox" checked={(a.roles ?? ['employee']).includes(r)} onChange={e => { const cur = a.roles ?? ['employee']; const roles = e.target.checked ? [...cur, r] : cur.filter(x => x !== r); setAct(i, { ...a, roles: roles.length ? roles : cur }); }} /> {r}s</label>)}
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={a.only_if_unassigned !== false} onChange={e => setAct(i, { ...a, only_if_unassigned: e.target.checked })} /> Only if the lead has no assignee</label></>}
            {a.type === 'assign_lead' && memberSelect(a.user_id, v => setAct(i, { ...a, user_id: v }), 'Assignee')}
            {a.type === 'create_task' && <>
              <div className="field"><input className="input" aria-label="Task title" value={a.title} maxLength={200} onChange={e => setAct(i, { ...a, title: e.target.value })} /></div>
              <span>due in</span>{numField(a.due_in_days, n => setAct(i, { ...a, due_in_days: n }), 'Days until due', 365)}<span>day(s), for</span>
              {memberSelect(a.owner, v => setAct(i, { ...a, owner: v }), 'Task owner', [['lead_assignee', 'The lead’s assignee']])}</>}
            {a.type === 'update_task_status' && <><select className="input" aria-label="New status" value={a.status} onChange={e => setAct(i, e.target.value === 'done' ? { type: 'update_task_status', status: 'done', outcome: a.outcome ?? 'Completed automatically' } : { type: 'update_task_status', status: 'open' })}><option value="done">Done</option><option value="open">Open</option></select>
              {a.status === 'done' && <div className="field"><input className="input" aria-label="Outcome" value={a.outcome ?? ''} onChange={e => setAct(i, { ...a, outcome: e.target.value })} /></div>}</>}
            {a.type === 'update_record' && <>
              <select className="input" aria-label="Field to update" value={a.field} onChange={e => setAct(i, { ...a, field: e.target.value })}><option value="">Choose a field…</option>{(modules.find(m => m.key === def.trigger.object)?.fields ?? []).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
              <span>to</span><div className="field"><input className="input" aria-label="New value" value={String(a.value)} onChange={e => setAct(i, { ...a, value: e.target.value })} /></div></>}
            {a.type === 'notify' && <>
              {memberSelect(a.recipient, v => setAct(i, { ...a, recipient: v }), 'Who to notify', [['event_actor', 'The person who triggered it'], ...(leadish ? [['lead_assignee', 'The lead’s assignee'] as [string, string]] : []), ...(scope === 'task' ? [['task_owner', 'The task owner'] as [string, string]] : [])])}
              <div className="field"><input className="input" aria-label="Notification title" placeholder="Title" value={a.title} maxLength={120} onChange={e => setAct(i, { ...a, title: e.target.value })} /></div>
              <div className="field"><input className="input" aria-label="Notification details" placeholder="Details (optional)" value={a.body ?? ''} maxLength={500} onChange={e => setAct(i, { ...a, body: e.target.value || undefined })} /></div></>}
            {a.type === 'wait' && <>
              <select className="input" aria-label="Wait mode" value={a.minutes !== undefined ? 'minutes' : 'field'} onChange={e => setAct(i, e.target.value === 'minutes' ? { type: 'wait', minutes: 60 } : { type: 'wait', until_field: fieldOptions[0]?.[0] ?? '' })}><option value="minutes">For a delay</option><option value="field" disabled={fieldOptions.length === 0}>Until a date field</option></select>
              {a.minutes !== undefined ? <>{numField(a.minutes, n => setAct(i, { ...a, minutes: n }), 'Minutes to wait', 525600)}<span>minutes</span></> : <select className="input" aria-label="Date field" value={a.until_field} onChange={e => setAct(i, { type: 'wait', until_field: e.target.value })}>{fieldOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</>}
            {a.type === 'request_integration' && <>
              <select className="input" aria-label="Channel" value={a.channel} onChange={e => setAct(i, { ...a, channel: e.target.value, ...(e.target.value === 'webhook' ? {} : { to: 'lead_contact' as const }) })}>{CHANNELS.map(c => <option key={c}>{c}</option>)}</select>
              <div className="field"><input className="input" aria-label="Message" value={a.message} maxLength={1000} onChange={e => setAct(i, { ...a, message: e.target.value })} /></div></>}
          </div>
          {a.type === 'request_integration' && <p className="muted">No messaging provider is connected. This only records a request; nothing is sent until a provider is connected for this channel.</p>}
          {a.type === 'wait' && <p className="muted">The delay is stored in the database and survives restarts. The next actions run after it, even if nobody has the app open.</p>}
        </div>)}
        <div className="inline"><select className="input" aria-label="Action to add" value={adding} onChange={e => setAdding(e.target.value as ActionType)}>{available.map(t => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}</select>
          <button type="button" className="btn" disabled={def.actions.length >= 10} onClick={() => set({ actions: [...def.actions, blank(available.includes(adding) ? adding : available[0]!)] })}>Add action</button></div>
      </div>
    </Card>

    <Card title="Preview" description="What this automation will do, in plain language.">
      {valid.ok ? <ol className="stack" style={{ gap: 4, margin: 0, paddingLeft: 20 }}>{describeAutomation(def, who).map(l => <li key={l}>{l.replace(/^\d+\. /, '')}</li>)}</ol> : <p className="err" role="alert">{valid.error}</p>}
    </Card>

    <Card title="Publish" description={publishedVersion ? `Version ${publishedVersion} is ${enabled ? 'live and enabled' : 'published but disabled'}. Publishing creates a new immutable version; runs already in progress keep the version they started with.` : 'Save a draft, review the preview, then publish. Only events that happen after you enable it are processed.'}>
      <div className="stack"><div className="row">
        <button type="button" className="btn primary" disabled={pending || !valid.ok || !dirty} onClick={save}>Save draft</button>
        <button type="button" className="btn" disabled={pending || !id || dirty || !draft || !valid.ok} onClick={() => run(() => publishAutomationAction(id!, true))}>Publish and enable</button>
        <button type="button" className="btn" disabled={pending || !id || dirty || !draft || !valid.ok} onClick={() => run(() => publishAutomationAction(id!, false))}>Publish (keep disabled)</button>
        {id && publishedVersion && <button type="button" className="btn" disabled={pending} onClick={() => run(() => setEnabledAction(id, !enabled))}>{enabled ? 'Disable' : 'Enable'}</button>}
        {id && draft && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Discard the saved draft?')) run(() => discardAutomationDraftAction(id)); }}>Discard draft</button>}
      </div>
      {dirty && <p className="muted">You have unsaved edits. Save the draft to enable publishing.</p>}
      {!valid.ok && <p className="err" role="alert">{valid.error}</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}</div>
    </Card>
  </div>;
}
