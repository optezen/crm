import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { appointment, appointmentLog, appointmentTypes, contactNames, freeSlots, members } from '../../../../../lib/operations/service';
import { OpsGate } from '../../../../../components/OpsGate';
import { Card } from '../../../../../components/ui/Card';
import { OpButton, OpForm } from '../../../../../components/OpForm';
import { SlotPicker } from '../../../../../components/SlotPicker';

export default async function AppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string }> }) {
  const { id } = await params; const sp = await searchParams; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <OpsGate module="appointments" config={s.config} role={s.role}>{await Body(s, id, sp.date)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>, id: string, date?: string) {
  const db = await supabaseServer(); const a = await appointment(db, s.organizationId, id); if (!a) notFound();
  const tz = s.config.operations?.appointments?.timezone ?? 'UTC'; const [types, team, log, names] = await Promise.all([appointmentTypes(db, s.organizationId), members(db, s.organizationId), appointmentLog(db, s.organizationId, id), contactNames(db, a.contact_id ? [a.contact_id] : [])]);
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const open = a.status === 'scheduled' || a.status === 'confirmed'; const slots = open && date && a.staff_id && /^\d{4}-\d{2}-\d{2}$/.test(date) ? await freeSlots(db, s.organizationId, a.staff_id, a.type_id, date) : [];
  const fields = s.config.operations?.appointments?.fields?.filter(f => !f.archived) ?? [];
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Appointment</span><h1>{types.find(t => t.id === a.type_id)?.name ?? 'Appointment'}</h1><p className="muted">{when(a.starts_at)} → {new Date(a.ends_at).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })} ({tz})</p></div><span className="badge">{a.status.replace('_', ' ')}</span></div>
    <Card title="Details">
      <div className="stack" style={{ gap: 6 }}><span>Staff: {a.staff_id ? team.find(m => m.id === a.staff_id)?.email : 'Unassigned'}</span><span>Customer: {a.contact_id ? names.get(a.contact_id) ?? 'Customer' : '—'}{a.lead_id && <> · <a href={`/work/leads/${a.lead_id}`}>open lead</a></>}</span>
        {a.notes && <span>Notes: {a.notes}</span>}{a.cancel_reason && <span>Cancelled: {a.cancel_reason}</span>}{a.reschedule_count > 0 && <span className="muted">Rescheduled {a.reschedule_count} time(s)</span>}
        {fields.map(f => a.custom[f.key] !== undefined && <span key={f.key}>{f.label}: {String(a.custom[f.key])}</span>)}</div></Card>
    {open && <Card title="Actions">
      <div className="stack">
        <div className="row">{a.status === 'scheduled' && <OpButton fn="appointment_confirm" args={{ p_id: a.id }} label="Confirm" message="Confirmed." />}
          <OpButton fn="appointment_finish" args={{ p_id: a.id, p_outcome: 'completed', p_notes: null }} label="Mark completed" confirmText="Mark this appointment as completed?" message="Completed." />
          <OpButton fn="appointment_finish" args={{ p_id: a.id, p_outcome: 'no_show', p_notes: null }} label="No-show" confirmText="Record a no-show?" message="Recorded." /></div>
        <OpForm fn="appointment_cancel" fixed={{ p_id: a.id }} fields={[{ name: 'p_reason', label: 'Cancellation reason', type: 'text' }]} submit="Cancel appointment" message="Cancelled." compact />
        <OpForm fn="appointment_set_notes" fixed={{ p_id: a.id, p_custom: null }} fields={[{ name: 'p_notes', label: 'Notes', type: 'textarea', defaultValue: a.notes ?? '', wide: true }]} submit="Save notes" message="Notes saved." /></div></Card>}
    {open && a.staff_id && <Card title="Reschedule" description="Pick a day to see the free slots; the duration stays the same.">
      <form className="row" action={`/work/appointments/${a.id}`}><label className="sr-only" htmlFor="rd">Day</label><input id="rd" name="date" type="date" className="input" style={{ width: 'auto' }} required defaultValue={date ?? ''} /><button className="btn">Show slots</button></form>
      {date && <SlotPicker fn="appointment_reschedule" fixed={{ p_id: a.id, p_staff: null }} slots={slots.map(x => ({ start: x.slot_start, end: x.slot_end }))} tz={tz} />}</Card>}
    <Card title="History">{log.map((l, i) => <div className="task" key={i}><strong>{l.action}</strong><span className="muted">{when(l.created_at)}{l.from_start && l.to_start ? ` · ${when(l.from_start)} → ${when(l.to_start)}` : ''}{l.note ? ` · ${l.note}` : ''}</span></div>)}</Card>
  </div>;
}
