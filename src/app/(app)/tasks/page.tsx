import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';
import { TaskDone } from '../../../components/ux/TaskDone';

const PAGE = 25;
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
/** All of my follow-ups with a simple filter and paging. Managers can switch to everyone's (row-level security still decides what they may see). */
export default async function Tasks({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null; const sp = await searchParams;
  const view = sp.view === 'overdue' ? 'overdue' : sp.view === 'done' ? 'done' : 'open'; const scope = sp.scope === 'all' && s.role !== 'employee' ? 'all' : 'mine'; const page = Math.max(1, Number(sp.page) || 1);
  const db = await supabaseServer(); const today = new Date().toISOString().slice(0, 10);
  let q = db.from('tasks').select('id, title, due_date, status, outcome, lead_id, owner_id', { count: 'exact' }).eq('organization_id', s.organizationId);
  if (scope === 'mine') q = q.eq('owner_id', s.userId);
  q = view === 'done' ? q.eq('status', 'done') : view === 'overdue' ? q.eq('status', 'open').lt('due_date', today) : q.eq('status', 'open');
  const { data, count, error } = await q.order('due_date', { ascending: view !== 'done' }).range((page - 1) * PAGE, page * PAGE - 1);
  if (error) return <Notice title="Tasks could not be loaded">Please try again.</Notice>;
  const rows = (data ?? []) as { id: string; title: string; due_date: string; status: string; outcome: string | null; lead_id: string }[];
  const ids = [...new Set(rows.map(r => r.lead_id))]; const nm = new Map<string, string>(); if (ids.length) for (const l of (await db.from('crm_lead_list').select('id, full_name').eq('organization_id', s.organizationId).in('id', ids)).data ?? []) nm.set(l.id, l.full_name);
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const link = (o: Record<string, string>) => `/tasks?${new URLSearchParams({ view, scope, ...o }).toString()}`;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Follow-ups</h1><p className="muted">{count ?? 0} {view === 'done' ? 'completed' : view === 'overdue' ? 'overdue' : 'open'}{scope === 'all' ? ' across the team' : ' assigned to you'}.</p></div></div>
    <nav className="seg" aria-label="Filter follow-ups">{(['open', 'overdue', 'done'] as const).map(v => <Link key={v} href={link({ view: v, page: '1' })} aria-current={v === view ? 'page' : undefined}>{v === 'open' ? 'Open' : v === 'overdue' ? 'Overdue' : 'Done'}</Link>)}
      {s.role !== 'employee' && <><span className="muted" aria-hidden>|</span><Link href={link({ scope: 'mine', page: '1' })} aria-current={scope === 'mine' ? 'page' : undefined}>Mine</Link><Link href={link({ scope: 'all', page: '1' })} aria-current={scope === 'all' ? 'page' : undefined}>Everyone</Link></>}</nav>
    <Card title="">
      {rows.length === 0 ? <p className="muted">{view === 'open' ? 'Nothing open. Follow-ups you create on leads appear here.' : view === 'overdue' ? 'Nothing is overdue.' : 'No completed follow-ups yet.'}</p>
        : <ul className="plain stack" style={{ gap: 14 }}>{rows.map(t => <li key={t.id}><div className="row" style={{ justifyContent: 'space-between' }}><span><Link href={`/work/leads/${t.lead_id}`}><strong>{t.title}</strong></Link><span className="muted"> · {nm.get(t.lead_id) ?? 'Lead'}</span>{t.outcome && <span className="muted"> · {t.outcome}</span>}</span><span className={`badge ${t.status === 'open' && t.due_date < today ? 'late' : 'done'}`}>{t.status === 'done' ? 'Done' : `Due ${fmt(t.due_date)}`}</span></div>{t.status === 'open' && scope === 'mine' && <TaskDone taskId={t.id} title={t.title} />}</li>)}</ul>}
    </Card>
    {pages > 1 && <nav className="row" aria-label="Pages"><Link className="btn" aria-disabled={page <= 1} href={link({ page: String(Math.max(1, page - 1)) })}>Previous</Link><span className="muted">Page {page} of {pages}</span><Link className="btn" aria-disabled={page >= pages} href={link({ page: String(Math.min(pages, page + 1)) })}>Next</Link></nav>}
  </div>;
}
