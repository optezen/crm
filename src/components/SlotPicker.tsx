'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { callOps } from '../app/(app)/work/ops-actions';
import type { FieldConfig } from '../lib/workspace/types';

/** Lets the user pick a conflict-free slot (computed by the database from working hours, time off and bookings) and book or move an appointment into it. The database re-checks everything on submit. */
export function SlotPicker({ fn, fixed, slots, tz, leads, customFields, withNotes }: { fn: 'appointment_create' | 'appointment_reschedule'; fixed: Record<string, unknown>; slots: { start: string; end: string }[]; tz: string; leads?: { id: string; name: string }[]; customFields?: FieldConfig[]; withNotes?: boolean }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [lead, setLead] = useState(''); const [notes, setNotes] = useState(''); const [custom, setCustom] = useState<Record<string, string | boolean>>({}); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const book = (startIso: string) => start(async () => {
    const args: Record<string, unknown> = { ...fixed, p_start: startIso };
    if (fn === 'appointment_create') { args.p_lead = lead || null; args.p_contact = null; args.p_notes = notes || null;
      const c: Record<string, unknown> = {}; for (const f of customFields ?? []) { const v = custom[f.key]; if (v === undefined || v === '') continue; c[f.key] = f.kind === 'number' || f.kind === 'currency' ? Number(v) : v; } args.p_custom = c; }
    const r = await callOps(fn, args, fn === 'appointment_create' ? 'Appointment booked.' : 'Appointment moved.'); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error });
    if (r.ok) { if (fn === 'appointment_create' && typeof r.data === 'string') router.push(`/work/appointments/${r.data}`); else router.refresh(); }
  });
  return <div className="stack" style={{ gap: 12 }}>
    {fn === 'appointment_create' && <div className="form-grid">
      {leads && <div className="field"><label htmlFor="sp-lead">Customer (lead)</label><select id="sp-lead" className="input" value={lead} onChange={e => setLead(e.target.value)}><option value="">— none —</option>{leads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
      {withNotes && <div className="field wide"><label htmlFor="sp-notes">Notes</label><textarea id="sp-notes" className="input" value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} /></div>}
      {(customFields ?? []).filter(f => !f.archived).map(f => <div className="field" key={f.key}><label htmlFor={`sp-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
        {f.kind === 'choice' ? <select id={`sp-${f.key}`} className="input" value={String(custom[f.key] ?? '')} onChange={e => setCustom({ ...custom, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map(o => <option key={o}>{o}</option>)}</select>
          : f.kind === 'yes_no' ? <input id={`sp-${f.key}`} type="checkbox" checked={custom[f.key] === true} onChange={e => setCustom({ ...custom, [f.key]: e.target.checked })} />
          : <input id={`sp-${f.key}`} className="input" type={f.kind === 'number' || f.kind === 'currency' ? 'number' : f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : 'text'} step="any" value={String(custom[f.key] ?? '')} onChange={e => setCustom({ ...custom, [f.key]: e.target.value })} />}</div>)}
    </div>}
    {slots.length === 0 ? <p className="muted">No free slots on that day (outside working hours, on time off, or fully booked).</p>
      : <div className="row" role="group" aria-label="Free time slots">{slots.map(s => <button key={s.start} type="button" className="btn" disabled={pending} onClick={() => book(s.start)} title={`${fmt(s.start)} to ${fmt(s.end)} (${tz})`}>{fmt(s.start)}</button>)}</div>}
    <p className="muted" style={{ fontSize: 12 }}>Times are shown in {tz}. Choosing a slot books it immediately; the database refuses double bookings.</p>
    {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
  </div>;
}
