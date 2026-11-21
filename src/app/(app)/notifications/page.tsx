import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { listNotifications } from '../../../lib/automation/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';
import { LocalTime } from '../../../components/ui/LocalTime';
import { markReadAction } from '../automations/actions';

export default async function Notifications() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const n = await listNotifications(await supabaseServer(), s.organizationId);
  if (!n.ok) return <Notice title="Notifications could not be loaded">{n.error}</Notice>;
  const unread = n.value.filter(x => !x.readAt).length;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen</span><h1>Notifications</h1><p className="muted">Messages from automations and your team, visible only to you.</p></div>
      {unread > 0 && <form action={markReadAction}><button className="btn">Mark all as read</button></form>}</div>
    <Card title={`Inbox (${unread} unread)`}>
      {n.value.length === 0 && <p className="muted">Nothing yet.</p>}
      {n.value.map(x => <div className="task" key={x.id}><div className="row">{x.link ? <Link href={x.link}><strong>{x.title}</strong></Link> : <strong>{x.title}</strong>}{!x.readAt && <span className="badge">New</span>}<span className="muted"><LocalTime iso={x.createdAt} /></span></div>{x.body && <p className="muted">{x.body}</p>}</div>)}
    </Card>
  </div>;
}
