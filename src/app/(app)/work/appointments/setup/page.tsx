import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { appointmentTypes, members, staffHours, timeOff } from '../../../../../lib/operations/service';
import { opsManage } from '../../../../../lib/operations/ops';
import { OpsGate } from '../../../../../components/OpsGate';
import { Card } from '../../../../../components/ui/Card';
import { Notice } from '../../../../../components/ui/Notice';
import { HoursEditor } from '../../../../../components/HoursEditor';
import { OpButton, OpForm } from '../../../../../components/OpForm';

export default async function AppointmentSetup() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!opsManage(s.role)) return <Notice title="Limited to owners, admins and managers">Ask a manager to change appointment types, working hours or time off.</Notice>;
  return <OpsGate module="appointments" config={s.config} role={s.role}>{await Body(s)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>) {
  const db = await supabaseServer(); const [types, team, hours, off] = await Promise.all([appointmentTypes(db, s.organizationId), members(db, s.organizationId), staffHours(db, s.organizationId), timeOff(db, s.organizationId)]);
  const tz = s.config.operations?.appointments?.timezone ?? 'UTC'; const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Appointment types &amp; working hours</h1><p className="muted">Whether this module is on, and its time zone, are set in Builder under “Business operations”.</p></div></div>
    <Card title="Appointment types" description="Each type has a fixed duration. Deactivating a type keeps existing appointments.">
      {types.map(t => <div className="task" key={t.id}><div className="row"><strong>{t.name}</strong><span className="muted">{t.duration_minutes} min</span>{!t.active && <span className="badge done">Inactive</span>}
        <OpButton fn="appointment_type_save" args={{ p_id: t.id, p_name: t.name, p_duration: t.duration_minutes, p_active: !t.active }} label={t.active ? 'Deactivate' : 'Activate'} /></div></div>)}
      <OpForm fn="appointment_type_save" fixed={{ p_id: null, p_active: true }} fields={[{ name: 'p_name', label: 'Name', required: true }, { name: 'p_duration', label: 'Duration (minutes)', type: 'number', required: true, step: '5' }]} submit="Add type" message="Type added." /></Card>
    <Card title="Working hours" description="Appointments with staff can only be booked inside these hours (when enforcement is on in Builder).">
      <div className="stack" style={{ gap: 10 }}>{team.map(m => <HoursEditor key={m.id} userId={m.id} label={m.email} initial={hours.filter(h => h.user_id === m.id)} />)}</div></Card>
    <Card title="Time off" description="Existing appointments are not cancelled automatically; you are told how many are affected.">
      {off.map(o => <div className="task" key={o.id}><div className="row"><strong>{team.find(m => m.id === o.user_id)?.email}</strong><span>{fmt(o.starts_at)} → {fmt(o.ends_at)} <span className="muted">({tz})</span></span>{o.reason && <span className="muted">{o.reason}</span>}<OpButton fn="staff_time_off_remove" args={{ p_id: o.id }} label="Remove" /></div></div>)}
      <OpForm fn="staff_time_off_add_local" fields={[{ name: 'p_user', label: 'Staff', type: 'select', required: true, options: team.map(m => [m.id, m.email]) }, { name: 'p_start_local', label: `From (${tz} time)`, type: 'datetime_local', required: true }, { name: 'p_end_local', label: `Until (${tz} time)`, type: 'datetime_local', required: true }, { name: 'p_reason', label: 'Reason' }]} submit="Add time off" message="Time off added." /></Card>
  </div>;
}
