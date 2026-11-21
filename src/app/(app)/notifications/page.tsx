import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { notificationPrefs, categoryLabel } from '../../../lib/ux/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';
import { LocalTime } from '../../../components/ui/LocalTime';
import { PrefsForm, ReadToggle } from '../../../components/ux/PrefsForm';
import { setReadAction } from './actions';

/** One inbox for task and lead assignments, overdue follow-ups and automation messages. In-app only: no email, push or WhatsApp delivery is claimed or performed here. */
export default async function Notifications({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null; const sp = await searchParams; const only = sp.filter === 'unread';
  const db = await supabaseServer();
  await db.rpc('notifications_generate_overdue', { p_org: s.organizationId });
  const [list, prefs] = await Promise.all([db.from('notifications').select('id, title, body, link, category, read_at, created_at').eq('organization_id', s.organizationId).order('created_at', { ascending: false }).limit(100), notificationPrefs(db, s.organizationId)]);
  if (list.error) return <Notice title="Notifications could not be loaded">Please try again.</Notice>;
  const all = (list.data ?? []).filter(n => (n.category === 'automation' ? prefs.automation : true)); const unread = all.filter(n => !n.read_at).length; const shown = only ? all.filter(n => !n.read_at) : all;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen</span><h1>Notifications</h1><p className="muted">Assignments, overdue follow-ups and automation messages, visible only to you.</p></div>
      {unread > 0 && <form action={async () => { 'use server'; await setReadAction(null, true); }}><button className="btn">Mark all as read</button></form>}</div>
    <nav className="seg" aria-label="Filter"><Link href="/notifications" aria-current={!only ? 'page' : undefined}>All</Link><Link href="/notifications?filter=unread" aria-current={only ? 'page' : undefined}>Unread ({unread})</Link></nav>
    <Card title="">
      {shown.length === 0 ? <p className="muted">{only ? 'You are all caught up.' : 'Nothing yet. You will see new assignments and overdue follow-ups here.'}</p>
        : <ul className="plain stack" style={{ gap: 0 }}>{shown.map(n => <li key={n.id} className="task"><div className="row" style={{ justifyContent: 'space-between' }}><span className="row" style={{ gap: 8 }}>{n.link ? <Link href={n.link}><strong>{n.title}</strong></Link> : <strong>{n.title}</strong>}{!n.read_at && <span className="badge">New</span>}<span className="tag">{categoryLabel[n.category] ?? n.category}</span></span><ReadToggle id={n.id} read={!!n.read_at} /></div>{n.body && <div className="muted">{n.body}</div>}<div className="muted" style={{ fontSize: 12 }}><LocalTime iso={n.created_at} /></div></li>)}</ul>}
    </Card>
    <Card title="What should notify me?" description="Per person. Muting a type stops new notifications of that type."><PrefsForm prefs={prefs} /></Card>
  </div>;
}
