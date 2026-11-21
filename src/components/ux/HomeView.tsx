import Link from 'next/link';
import type { Home } from '../../lib/ux/service';
import { Card } from '../ui/Card';
import { LocalTime } from '../ui/LocalTime';
import { TaskDone } from './TaskDone';

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const fmtTime = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
export type HomeProps = { d: Home; businessName: string; me: string | undefined; manager: boolean; builder: boolean; leadsOn: boolean; tz: string; apptOn: boolean; billingOn: boolean; custom: { key: string; label: string }[]; stages: string[]; counts: Record<string, number> | null };
/** Presentation of the Work Mode home. Pure: every value comes from the caller's own data (or, in browser tests only, a labelled fixture). */
export function HomeView({ d, businessName, me, manager, builder, leadsOn, tz, apptOn, billingOn, custom, stages, counts }: HomeProps) {
  const steps = builder ? [
    { done: d.leads_total > 0, label: 'Add your first lead', href: '/work/leads/new', show: leadsOn },
    { done: d.members > 1, label: 'Invite your team', href: '/team', show: true },
    { done: custom.length > 0, label: 'Track what is special about your business (modules and fields)', href: '/builder/home', show: true }] .filter(x => x.show) : [];
  const todo = steps.filter(x => !x.done);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">{businessName}</span><h1>{me ? `Hello, ${me}` : 'Your day'}</h1><p className="muted">{d.open_tasks === 0 && d.my_leads === 0 ? 'Nothing is waiting for you right now.' : `${d.open_tasks} open follow-up${d.open_tasks === 1 ? '' : 's'}${d.overdue_tasks ? `, ${d.overdue_tasks} overdue` : ''} · ${d.my_leads} lead${d.my_leads === 1 ? '' : 's'} assigned to you.`}</p></div></div>
    <nav className="quick" aria-label="Quick actions">
      {leadsOn && <Link className="btn primary" href="/work/leads/new">+ New lead</Link>}
      {apptOn && <Link className="btn" href="/work/appointments/new">+ Book appointment</Link>}
      {billingOn && <Link className="btn" href="/work/billing/new">+ New invoice</Link>}
      {custom.map(m => <Link key={m.key} className="btn" href={`/work/${m.key}/new`}>+ {m.label}</Link>)}
      <Link className="btn" href="/search">Search everything</Link>
    </nav>
    {todo.length > 0 && <Card title="Get started" description="A few quick steps. They disappear as you complete them."><ol className="stack" style={{ gap: 6, margin: 0, paddingLeft: 20 }}>{steps.map(x => <li key={x.label} style={x.done ? { textDecoration: 'line-through', opacity: .6 } : undefined}>{x.done ? x.label : <Link href={x.href}>{x.label}</Link>}</li>)}</ol></Card>}
    <div className="grid">
      <Card title="My follow-ups" description="Open tasks assigned to you, soonest first.">
        {d.tasks.length === 0 ? <p className="muted">{leadsOn ? 'You are all caught up. New follow-ups from leads appear here.' : 'No tasks.'}</p>
          : <ul className="plain stack" style={{ gap: 12 }}>{d.tasks.map(t => <li key={t.id}><div className="row" style={{ justifyContent: 'space-between' }}><span><Link href={`/work/leads/${t.lead_id}`}><strong>{t.title}</strong></Link>{t.lead ? <span className="muted"> · {t.lead}</span> : null}</span><span className={`badge ${t.overdue ? 'late' : ''}`}>{t.overdue ? 'Overdue ' : 'Due '}{fmtDate(t.due)}</span></div><TaskDone taskId={t.id} title={t.title} /></li>)}</ul>}
        {d.open_tasks > d.tasks.length && <p className="muted" style={{ marginBottom: 0 }}><Link href="/tasks">See all {d.open_tasks}</Link></p>}
      </Card>
      {leadsOn && <Card title="My leads" description="Leads assigned to you, most recently updated first.">
        {d.leads.length === 0 ? <p className="muted">No leads are assigned to you yet.{d.unassigned_leads > 0 ? <> There {d.unassigned_leads === 1 ? 'is' : 'are'} {d.unassigned_leads} unassigned lead{d.unassigned_leads === 1 ? '' : 's'}: <Link href="/work/leads?assignee=unassigned">take a look</Link>.</> : null}</p>
          : <ul className="plain stack" style={{ gap: 8 }}>{d.leads.map(l => <li key={l.id} className="row" style={{ justifyContent: 'space-between' }}><Link href={`/work/leads/${l.id}`}><strong>{l.name}</strong></Link><span className="badge">{l.stage}</span></li>)}</ul>}
        <p style={{ marginBottom: 0 }}><Link href="/work/leads">All leads</Link> · <Link href="/work/leads/board">Board</Link></p>
      </Card>}
      {d.appointments_enabled && apptOn && <Card title="Today's appointments" description={manager ? 'Everyone’s appointments today.' : 'Your appointments today.'}>
        {d.appointments.length === 0 ? <p className="muted">No appointments today.</p> : <ul className="plain stack" style={{ gap: 8 }}>{d.appointments.map(a => <li key={a.id} className="row" style={{ justifyContent: 'space-between' }}><Link href={`/work/appointments/${a.id}`}><strong>{fmtTime(a.starts_at, tz)}</strong> {a.type}{a.contact ? ` · ${a.contact}` : ''}</Link><span className="badge done">{a.status}</span></li>)}</ul>}
        <p style={{ marginBottom: 0 }}><Link href="/work/appointments">Open calendar</Link></p>
      </Card>}
      <Card title={`Notifications${d.unread ? ` (${d.unread} new)` : ''}`} description="In-app only. Optizen does not send email, push or WhatsApp notifications for these.">
        {d.notifications.length === 0 ? <p className="muted">Nothing new.</p> : <ul className="plain stack" style={{ gap: 8 }}>{d.notifications.map(n => <li key={n.id}>{n.link ? <Link href={n.link}><strong>{n.title}</strong></Link> : <strong>{n.title}</strong>}{n.body && <span className="muted"> · {n.body}</span>} <span className="muted" style={{ fontSize: 12 }}><LocalTime iso={n.created_at} /></span></li>)}</ul>}
        <p style={{ marginBottom: 0 }}><Link href="/notifications">Open notification center</Link></p>
      </Card>
    </div>
    {manager && counts && <Card title="Pipeline" description="Leads you can see, by stage."><div className="chips">{stages.map(x => <Link key={x} className="chip" href={`/work/leads?stage=${encodeURIComponent(x)}`}>{x} · {counts[x] ?? 0}</Link>)}</div></Card>}
  </div>;
}
