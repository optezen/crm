import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../lib/crm/context';
import { isManager, listLeads, listMembers, stageCounts } from '../../../../lib/crm/service';
import { parseListParams } from '../../../../lib/crm/validate';
import { LEAD_SOURCES, PAGE_SIZE, SOURCE_LABEL } from '../../../../lib/crm/types';
import { LeadsTable } from '../../../../components/crm/LeadsTable';
import { Notice } from '../../../../components/ui/Notice';

type SP = Promise<Record<string, string | string[] | undefined>>;
const ago = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 60) return `${m || 1}m ago`; if (m < 1440) return `${Math.round(m / 60)}h ago`; const d = Math.round(m / 1440); return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

export default async function Leads({ searchParams }: { searchParams: SP }) {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  const params = parseListParams(await searchParams, ctx.stages);
  const [res, mem, counts] = await Promise.all([listLeads(ctx, params), listMembers(ctx), stageCounts(ctx)]);
  if (!res.ok) return <Notice title="Leads could not be loaded">{res.error}</Notice>;
  const members = mem.ok ? mem.value : [];
  const manager = isManager(ctx.role);
  // next open follow-up per lead on this page (one query), shown as a chip like "Today" / "Nov 26"
  const due = new Map<string, string>();
  if (res.value.rows.length) { const t = await ctx.db.from('tasks').select('lead_id, due_date').eq('organization_id', ctx.organizationId).eq('status', 'open').in('lead_id', res.value.rows.map(r => r.id)).order('due_date'); for (const x of t.data ?? []) if (!due.has(x.lead_id)) due.set(x.lead_id, x.due_date); }
  const today = new Date().toISOString().slice(0, 10);
  const chip = (id: string) => { const d = due.get(id); if (!d) return null; return { text: d === today ? 'Today' : d < today ? 'Overdue' : new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }), tone: d < today ? 'late' : d === today ? 'today' : 'later' }; };
  const label = (m: { userId: string; email: string }) => m.userId === ctx.userId ? 'Me' : m.email;
  const who = (id: string | null) => id === null ? 'Unassigned' : id === ctx.userId ? 'Me' : members.find(m => m.userId === id)?.email ?? 'Former member';
  const { rows, total, page, pageCount } = res.value;
  const qs = (o: Record<string, string | number | null | undefined>) => { const u = new URLSearchParams(); const all = { q: params.q, stage: params.stage, source: params.source, assignee: params.assignee, sort: params.sort === 'created' ? null : params.sort, dir: params.dir === 'asc' ? 'asc' : null, ...o }; for (const [k, v] of Object.entries(all)) if (v) u.set(k, String(v)); const s = u.toString(); return `/work/leads${s ? `?${s}` : ''}`; };
  const filtered = Boolean(params.q || params.stage || params.source || params.assignee);
  const sum = Object.values(counts.ok ? counts.value : {}).reduce((a, b) => a + b, 0);
  const sortHref = (k: 'name' | 'updated') => qs({ sort: k, dir: params.sort === k && params.dir === 'asc' ? null : params.dir === 'desc' && params.sort === k ? 'asc' : k === 'name' ? 'asc' : null, page: null });
  const exportHref = `/work/leads/export${qs({}).slice('/work/leads'.length)}`;
  return <div className="stack lt-page">
    <div className="top"><h1 style={{ margin: 0 }}>Leads <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>{total}{filtered ? ' match' : ''}</span></h1>
      <div className="row"><Link className="btn" href="/work/leads/board">Board</Link><Link className="btn" href="/work/leads/import">Import</Link>{manager && <a className="btn" href={exportHref}>Export</a>}<Link className="btn primary" href="/work/leads/new">+ New lead</Link></div></div>
    <nav className="tabs" aria-label="Filter by stage"><Link href={qs({ stage: null })} aria-current={!params.stage ? 'page' : undefined}>All{counts.ok && <span>{sum}</span>}</Link>
      {ctx.stages.map(s => <Link key={s} href={qs({ stage: s, page: null })} aria-current={params.stage === s ? 'page' : undefined}>{s}{counts.ok && <span>{counts.value[s] ?? 0}</span>}</Link>)}</nav>
    <form className="lt-filters" method="get" role="search" aria-label="Search and filter leads">
      {params.stage && <input type="hidden" name="stage" value={params.stage} />}
      <input name="q" type="search" className="input grow" aria-label="Search leads" defaultValue={params.q} placeholder="Search name, phone, email or notes" />
      <select name="source" className="input" aria-label="Source" defaultValue={params.source ?? ''}><option value="">Any source</option>{LEAD_SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select>
      <select name="assignee" className="input" aria-label="Owner" defaultValue={params.assignee ?? ''}><option value="">Any owner</option><option value="me">Me</option><option value="unassigned">Unassigned</option>{members.filter(m => m.userId !== ctx.userId).map(m => <option key={m.userId} value={m.userId}>{m.email}</option>)}</select>
      <button className="btn">Search</button>{filtered && <Link className="btn" href="/work/leads">Clear</Link>}
    </form>
    {rows.length === 0
      ? <div className="empty-state"><strong>{filtered ? 'No leads match.' : 'No leads yet.'}</strong><p className="muted">{filtered ? 'Try a different search or clear the filters.' : 'Add your first lead, or import a spreadsheet.'}</p><div className="row">{filtered ? <Link className="btn" href="/work/leads">Clear filters</Link> : <><Link className="btn primary" href="/work/leads/new">+ New lead</Link><Link className="btn" href="/work/leads/import">Import a CSV</Link></>}</div></div>
      : <LeadsTable sort={{ by: params.sort ?? 'created', dir: params.dir ?? 'desc', name: sortHref('name'), updated: sortHref('updated') }} stages={[...ctx.stages]} manager={manager} owners={members.map(m => ({ id: m.userId, label: label(m) }))}
          rows={rows.map(r => ({ id: r.id, name: r.fullName, summary: r.summary, phone: r.phone, email: r.email, hidden: r.contactHidden, stage: r.stage, source: SOURCE_LABEL[r.source], owner: who(r.assignedTo), ago: ago(r.updatedAt), tasks: r.openTasks, due: chip(r.id) }))} />}
    {rows.length > 0 && <nav className="lt-foot" aria-label="Pagination"><span>Total leads <strong>{total}</strong></span>
      <span className="row" style={{ gap: 8 }}>{page > 1 ? <Link className="btn" href={qs({ page: page - 1 })} aria-label="Previous page">←</Link> : <span className="btn" aria-hidden style={{ opacity: .35 }}>←</span>}
        <span>{(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, total)}</span>
        {page < pageCount ? <Link className="btn" href={qs({ page: page + 1 })} aria-label="Next page">→</Link> : <span className="btn" aria-hidden style={{ opacity: .35 }}>→</span>}</span></nav>}
  </div>;
}
