import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { getRecordsContext } from '../../../../lib/records/context';
import { listRecords } from '../../../../lib/records/service';
import { activeFields, findModule, formatValue, parseRecordListParams } from '../../../../lib/records/validate';
import { DataTable } from '../../../../components/ui/DataTable';
import { Notice } from '../../../../components/ui/Notice';

export default async function ModulePage({ params, searchParams }: { params: Promise<{ module: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { module } = await params;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const mod = s.config.modules.find(m => m.key === module && m.status === 'active');
  if (!mod) notFound(); // planned, hidden or unknown modules have no page
  const found = findModule(s.config, module);
  if (!found) return <div className="stack"><div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>{mod.label}</h1></div></div>
    <p className="muted">{mod.label} has no fields defined yet. An owner or admin can add them in Builder.</p></div>;
  const ctx = await getRecordsContext(); if (!ctx) return null;
  const { object } = found, fields = activeFields(object), sp = await searchParams;
  const p = parseRecordListParams(sp, object);
  const res = await listRecords(ctx, module, p);
  if (!res.ok) return <Notice title={`${mod.label} could not be loaded`}>{res.error}</Notice>;
  const { rows, total, page, pageCount } = res.value;
  const filterable = fields.filter(f => f.kind === 'choice' || f.kind === 'yes_no');
  const href = (n: number) => { const u = new URLSearchParams(); if (p.q) u.set('q', p.q); for (const [k, v] of Object.entries(p.filters)) u.set(`f_${k}`, v); if (n > 1) u.set('page', String(n)); const q = u.toString(); return `/work/${module}${q ? `?${q}` : ''}`; };
  const filtered = Boolean(p.q || Object.keys(p.filters).length);
  const cols = fields.slice(0, 5);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>{mod.label}</h1><p className="muted">{total} {total === 1 ? 'record' : 'records'}{filtered ? ' match your filters' : ''}.</p></div>
      <div className="row">{fields.some(f => f.kind === 'choice') && <Link className="btn" href={`/work/${module}/board`}>Board view</Link>}<Link className="btn primary" href={`/work/${module}/new`}>Add record</Link></div></div>
    <form className="filters" method="get" role="search" aria-label={`Filter ${mod.label}`}>
      <div className="field grow"><label htmlFor="q">Search</label><input id="q" name="q" className="input" defaultValue={p.q} placeholder="Search all fields" /></div>
      {filterable.map(f => <div className="field" key={f.key}><label htmlFor={`flt-${f.key}`}>{f.label}</label>
        <select id={`flt-${f.key}`} name={`f_${f.key}`} className="input" defaultValue={p.filters[f.key] ?? ''}><option value="">Any</option>{f.kind === 'choice' ? (f.options ?? []).map(o => <option key={o}>{o}</option>) : <><option value="yes">Yes</option><option value="no">No</option></>}</select></div>)}
      <button className="btn">Apply</button>{filtered && <Link className="btn" href={`/work/${module}`}>Clear</Link>}
    </form>
    <DataTable caption={mod.label} rows={rows} empty={filtered ? 'No records match these filters.' : `No ${mod.label.toLowerCase()} yet. Add the first record.`}
      columns={[...cols.map((f, i) => ({ header: f.label, cell: (r: (typeof rows)[number]) => { const t = formatValue(f, r.data[f.key]) || '—'; return i === 0 ? <Link href={`/work/${module}/${r.id}`}><strong>{t}</strong></Link> : t; } })),
        ...(cols.length === 0 ? [{ header: 'Record', cell: (r: (typeof rows)[number]) => <Link href={`/work/${module}/${r.id}`}>Open</Link> }] : []),
        { header: 'Added', cell: r => new Date(r.createdAt).toLocaleDateString('en-GB', { timeZone: 'UTC' }) }]} />
    {pageCount > 1 && <nav className="pager" aria-label="Pagination">
      {page > 1 ? <Link className="btn" href={href(page - 1)}>Previous</Link> : <span />}<span className="muted">Page {page} of {pageCount}</span>
      {page < pageCount ? <Link className="btn" href={href(page + 1)}>Next</Link> : <span />}</nav>}
  </div>;
}
