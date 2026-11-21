import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { globalSearch, type SearchItem } from '../../../lib/ux/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';

const TYPES: [string, string][] = [['', 'Everything'], ['lead', 'Leads'], ['task', 'Follow-ups'], ['appointment', 'Appointments'], ['invoice', 'Invoices'], ['record', 'Other records']];
const ICON: Record<SearchItem['type'], string> = { lead: 'Lead', task: 'Follow-up', appointment: 'Appointment', invoice: 'Invoice', record: 'Record' };
/** Search across what you are allowed to see. Results show names, numbers, stages and dates, never phone numbers or email addresses, and a hidden contact detail cannot be used to find a record. */
export default async function Search({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null; const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 80) : ''; const type = typeof sp.type === 'string' && TYPES.some(([k]) => k === sp.type) ? sp.type : ''; const page = Math.max(1, Math.min(50, Number(sp.page) || 1));
  const res = q.length >= 2 ? await globalSearch(await supabaseServer(), s.organizationId, q, type ? [type] : null, page) : null;
  const href = (o: Record<string, string>) => `/search?${new URLSearchParams({ q, ...(type ? { type } : {}), ...o }).toString()}`;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen</span><h1>Search</h1><p className="muted">Leads, follow-ups, appointments, invoices and records you are allowed to see.</p></div></div>
    <form method="get" role="search" className="row" style={{ gap: 8 }}><label className="sr-only" htmlFor="sq">Search</label><input id="sq" name="q" type="search" className="input" style={{ flex: 1, minWidth: 200 }} defaultValue={q} placeholder="A name, a task, an invoice number…" autoFocus={!q} />
      <label className="sr-only" htmlFor="st">Type</label><select id="st" name="type" className="input" defaultValue={type}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><button className="btn primary">Search</button></form>
    {!res && <Card title=""><p className="muted">{q.length === 0 ? 'Type at least two characters.' : 'Type at least two characters to search.'}</p></Card>}
    {res && !res.ok && <Notice title="Search could not run">{res.error}</Notice>}
    {res?.ok && <Card title={res.value.items.length === 0 ? '' : `Results${page > 1 ? ` (page ${page})` : ''}`}>
      {res.value.items.length === 0 ? <p className="muted">Nothing found for “{q}”. Check the spelling, or try a shorter word. You only see what your role allows.</p>
        : <ul className="plain stack" style={{ gap: 12 }}>{res.value.items.map(i => <li key={`${i.type}-${i.id}`}><Link href={i.link}><strong>{i.title}</strong></Link> <span className="tag">{ICON[i.type]}</span><div className="muted" style={{ fontSize: 13 }}>{i.subtitle}</div></li>)}</ul>}
    </Card>}
    {res?.ok && (page > 1 || res.value.hasMore) && <nav className="row" aria-label="Pages">{page > 1 && <Link className="btn" href={href({ page: String(page - 1) })}>Previous</Link>}{res.value.hasMore && <Link className="btn" href={href({ page: String(page + 1) })}>Next</Link>}</nav>}
  </div>;
}
