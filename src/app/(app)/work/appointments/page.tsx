import Link from 'next/link';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { appointmentTypes, appointmentsBetween, contactNames, members } from '../../../../lib/operations/service';
import { opsManage } from '../../../../lib/operations/ops';
import { OpsGate } from '../../../../components/OpsGate';
import { Card } from '../../../../components/ui/Card';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export default async function Appointments({ searchParams }: { searchParams: Promise<{ week?: string; staff?: string }> }) {
  const sp = await searchParams; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  return <OpsGate module="appointments" config={s.config} role={s.role}>{await Body(s, sp)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>, sp: { week?: string; staff?: string }) {
  const tz = s.config.operations?.appointments?.timezone ?? 'UTC'; const db = await supabaseServer();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); const base = /^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? '') ? sp.week! : today;
  const dow = new Date(`${base}T00:00:00Z`).getUTCDay(); const monday = addDays(base, -((dow + 6) % 7)); const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const staffId = /^[0-9a-f-]{36}$/i.test(sp.staff ?? '') ? sp.staff : undefined;
  const [rows, types, team] = await Promise.all([appointmentsBetween(db, s.organizationId, `${addDays(monday, -1)}T00:00:00Z`, new Date(`${addDays(monday, 8)}T00:00:00Z`).toISOString(), staffId), appointmentTypes(db, s.organizationId), members(db, s.organizationId)]);
  const names = await contactNames(db, rows.flatMap(r => (r.contact_id ? [r.contact_id] : [])));
  const key = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const typeName = new Map(types.map(t => [t.id, t.name])), who = new Map(team.map(m => [m.id, m.email]));
  const q = (week: string) => `?week=${week}${staffId ? `&staff=${staffId}` : ''}`;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Appointments</h1><p className="muted">Week of {monday} · times in {tz}. Reminders are not sent: no messaging provider is connected.</p></div>
      <div className="row"><Link className="btn primary" href="/work/appointments/new">Book appointment</Link>{opsManage(s.role) && <Link className="btn" href="/work/appointments/setup">Types &amp; hours</Link>}</div></div>
    <div className="row"><Link className="btn" href={q(addDays(monday, -7))}>← Previous</Link><Link className="btn" href={q(today)}>Today</Link><Link className="btn" href={q(addDays(monday, 7))}>Next →</Link>
      <form className="row" action="/work/appointments"><input type="hidden" name="week" value={monday} /><label className="sr-only" htmlFor="staff">Staff</label><select id="staff" name="staff" className="input" defaultValue={staffId ?? ''}><option value="">All staff</option>{team.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}</select><button className="btn">Filter</button></form></div>
    {days.map(d => { const list = rows.filter(r => key(r.starts_at) === d); return <Card key={d} title={`${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}${d === today ? ' · today' : ''}`}>
      {list.length === 0 ? <p className="muted">Nothing booked.</p> : list.map(a => <div className="task" key={a.id}><div className="row"><Link href={`/work/appointments/${a.id}`}><strong>{hm(a.starts_at)}–{hm(a.ends_at)} · {typeName.get(a.type_id) ?? 'Appointment'}</strong></Link>
        <span className={`badge ${a.status === 'cancelled' || a.status === 'no_show' ? 'late' : a.status === 'completed' ? 'done' : ''}`}>{a.status.replace('_', ' ')}</span></div>
        <span className="muted">{a.staff_id ? who.get(a.staff_id) ?? 'Staff' : 'Unassigned'}{a.contact_id ? ` · ${names.get(a.contact_id) ?? 'Customer'}` : ''}</span></div>)}</Card>; })}
  </div>;
}
