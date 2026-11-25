import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../lib/crm/context';
import { listLeads, listMembers } from '../../../../lib/crm/service';
import { parseListParams } from '../../../../lib/crm/validate';
import { LEAD_SOURCES, SOURCE_LABEL } from '../../../../lib/crm/types';
import { DataTable } from '../../../../components/ui/DataTable';
import { Notice } from '../../../../components/ui/Notice';

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Leads({ searchParams }: { searchParams: SP }) {
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  const params = parseListParams(await searchParams, ctx.stages);
  const [res, mem] = await Promise.all([listLeads(ctx, params), listMembers(ctx)]);
  if (!res.ok) return <Notice title="Leads could not be loaded">{res.error}</Notice>;
  const members = mem.ok ? mem.value : [];
  const who = (id: string | null) => id === null ? 'Unassigned' : id === ctx.userId ? 'Me' : members.find(m => m.userId === id)?.email ?? 'Former member';
  const { rows, total, page, pageCount } = res.value;
  const href = (p: number) => { const u = new URLSearchParams(); if (params.q) u.set('q', params.q); if (params.stage) u.set('stage', params.stage); if (params.source) u.set('source', params.source); if (params.assignee) u.set('assignee', params.assignee); if (p > 1) u.set('page', String(p)); const s = u.toString(); return `/work/leads${s ? `?${s}` : ''}`; };
  const filtered = Boolean(params.q || params.stage || params.source || params.assignee);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Leads</h1><p className="muted">{total} {total === 1 ? 'lead' : 'leads'}{filtered ? ' match your filters' : ''}.</p></div>
      <div className="row"><Link className="btn" href="/work/leads/board">Board view</Link><Link className="btn" href="/work/leads/import">Import</Link><Link className="btn primary" href="/work/leads/new">New lead</Link></div></div>
    <form className="filters" method="get" role="search" aria-label="Filter leads">
      <div className="field grow"><label htmlFor="q">Search</label><input id="q" name="q" className="input" defaultValue={params.q} placeholder="Name, phone, email or notes" /></div>
      <div className="field"><label htmlFor="f-stage">Stage</label><select id="f-stage" name="stage" className="input" defaultValue={params.stage ?? ''}><option value="">All stages</option>{ctx.stages.map(s => <option key={s}>{s}</option>)}</select></div>
      <div className="field"><label htmlFor="f-source">Source</label><select id="f-source" name="source" className="input" defaultValue={params.source ?? ''}><option value="">All sources</option>{LEAD_SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></div>
      <div className="field"><label htmlFor="f-assignee">Assigned to</label><select id="f-assignee" name="assignee" className="input" defaultValue={params.assignee ?? ''}><option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>{members.filter(m => m.userId !== ctx.userId).map(m => <option key={m.userId} value={m.userId}>{m.email}</option>)}</select></div>
      <button className="btn">Apply</button>{filtered && <Link className="btn" href="/work/leads">Clear</Link>}
    </form>
    <DataTable caption="Leads" rows={rows} empty={filtered ? 'No leads match these filters.' : 'No leads yet. Add your first lead to start the pipeline.'} columns={[
      { header: 'Name', cell: r => <Link href={`/work/leads/${r.id}`}><strong>{r.fullName}</strong></Link> },
      { header: 'Contact', cell: r => r.contactHidden ? <span className="muted">Hidden by your role</span> : <span>{r.phone ?? ''}{r.phone && r.email ? <br /> : null}{r.email ?? ''}{!r.phone && !r.email ? '—' : ''}</span> },
      { header: 'Stage', cell: r => <span className="badge">{r.stage}</span> },
      { header: 'Source', cell: r => SOURCE_LABEL[r.source] },
      { header: 'Assigned to', cell: r => who(r.assignedTo) },
      { header: 'Open tasks', cell: r => r.openTasks },
    ]} />
    {pageCount > 1 && <nav className="pager" aria-label="Pagination">
      {page > 1 ? <Link className="btn" href={href(page - 1)}>Previous</Link> : <span />}
      <span className="muted">Page {page} of {pageCount}</span>
      {page < pageCount ? <Link className="btn" href={href(page + 1)}>Next</Link> : <span />}
    </nav>}
  </div>;
}
