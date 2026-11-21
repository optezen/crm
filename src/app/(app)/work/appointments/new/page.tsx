import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { appointmentTypes, freeSlots, members, recentLeads } from '../../../../../lib/operations/service';
import { OpsGate } from '../../../../../components/OpsGate';
import { Card } from '../../../../../components/ui/Card';
import { Notice } from '../../../../../components/ui/Notice';
import { SlotPicker } from '../../../../../components/SlotPicker';

export default async function NewAppointment({ searchParams }: { searchParams: Promise<{ type?: string; staff?: string; date?: string }> }) {
  const sp = await searchParams; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  return <OpsGate module="appointments" config={s.config} role={s.role}>{await Body(s, sp)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>, sp: { type?: string; staff?: string; date?: string }) {
  const db = await supabaseServer(); const tz = s.config.operations?.appointments?.timezone ?? 'UTC';
  const [types, team, leads] = await Promise.all([appointmentTypes(db, s.organizationId), members(db, s.organizationId), recentLeads(db, s.organizationId)]);
  const active = types.filter(t => t.active); const ready = sp.type && sp.staff && /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '');
  const slots = ready ? await freeSlots(db, s.organizationId, sp.staff!, sp.type!, sp.date!) : [];
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Book an appointment</h1></div></div>
    {active.length === 0 && <Notice title="No appointment types yet">A manager, admin or owner must create appointment types and staff working hours first (Appointments → Types &amp; hours).</Notice>}
    <Card title="1. Choose type, staff and day" description="Free slots come from the staff member’s working hours, time off and existing bookings.">
      <form className="form-grid" action="/work/appointments/new">
        <div className="field"><label htmlFor="type">Type</label><select id="type" name="type" className="input" required defaultValue={sp.type ?? ''}><option value="">Choose…</option>{active.map(t => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes} min)</option>)}</select></div>
        <div className="field"><label htmlFor="staff">Staff</label><select id="staff" name="staff" className="input" required defaultValue={sp.staff ?? ''}><option value="">Choose…</option>{team.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}</select></div>
        <div className="field"><label htmlFor="date">Day</label><input id="date" name="date" type="date" className="input" required defaultValue={sp.date ?? ''} /></div>
        <div className="field" style={{ justifyContent: 'flex-end' }}><button className="btn">Show free slots</button></div></form></Card>
    {ready && <Card title="2. Pick a time"><SlotPicker fn="appointment_create" fixed={{ p_type: sp.type, p_staff: sp.staff }} slots={slots.map(x => ({ start: x.slot_start, end: x.slot_end }))} tz={tz} leads={leads.map(l => ({ id: l.id, name: l.full_name }))} customFields={s.config.operations?.appointments?.fields} withNotes /></Card>}
  </div>;
}
