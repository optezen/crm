'use client';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { bulkLeadsAction } from '../../app/(app)/work/leads/actions';

export type LeadRowView = { id: string; name: string; summary: string | null; phone: string | null; email: string | null; hidden: boolean; stage: string; source: string; owner: string; ago: string; tasks: number; due: { text: string; tone: string } | null };
const wa = (p: string) => `https://wa.me/${p.replace(/\D/g, '')}`;

/** The working list: tabs and filters live on the page; this handles selection, in-place stage change and bulk actions. */
export function LeadsTable({ rows, stages, owners, manager, sort }: { rows: LeadRowView[]; stages: string[]; owners: { id: string; label: string }[]; manager: boolean; sort: { by: string; dir: string; name: string; updated: string } }) {
  const [sel, setSel] = useState<Set<string>>(new Set()); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null); const [pending, start] = useTransition();
  const COLS = [['email', 'Email'], ['source', 'Source'], ['notes', 'Notes'], ['owner', 'Owner'], ['updated', 'Updated']] as const;
  const [cols, setCols] = useState<string[]>(['email', 'source', 'owner', 'updated']);
  useEffect(() => { try { const v = localStorage.getItem('lead-cols'); if (v) setCols(JSON.parse(v)); } catch {} }, []);
  const flip = (k: string) => setCols(c => { const n = c.includes(k) ? c.filter(x => x !== k) : [...c, k]; try { localStorage.setItem('lead-cols', JSON.stringify(n)); } catch {} return n; });
  const on = (k: string) => cols.includes(k);
  const all = rows.length > 0 && sel.size === rows.length;
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = (ids: string[], op: { stage?: string; assignee?: string | null }) => start(async () => {
    const r = await bulkLeadsAction(ids, op); setMsg({ ok: !r?.error, text: r?.error ?? r?.ok ?? '' }); if (!r?.error) setSel(new Set());
  });
  if (rows.length === 0) return null;
  const showDue = rows.some(r => r.due); const arrow = (k: string) => sort.by === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return <div className="lt">
    {sel.size > 0 && <div className="lt-bulk" role="region" aria-label="Bulk actions"><strong>{sel.size} selected</strong>
      <select className="input" aria-label="Move selected to stage" defaultValue="" disabled={pending} onChange={e => { if (e.target.value) { run([...sel], { stage: e.target.value }); e.target.value = ''; } }}><option value="">Move to stage…</option>{stages.map(s => <option key={s}>{s}</option>)}</select>
      {manager && <select className="input" aria-label="Assign selected to" defaultValue="" disabled={pending} onChange={e => { if (e.target.value) { run([...sel], { assignee: e.target.value === '__none' ? null : e.target.value }); e.target.value = ''; } }}><option value="">Assign to…</option><option value="__none">Unassigned</option>{owners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}
      <button className="btn" onClick={() => setSel(new Set())}>Clear</button></div>}
    {msg && <p className={msg.ok ? 'ok' : 'err'} role="status">{msg.text}</p>}
    <details className="lt-cols"><summary className="btn">Columns</summary><div>{COLS.map(([k, l]) => <label key={k}><input type="checkbox" checked={on(k)} onChange={() => flip(k)} /> {l}</label>)}</div></details>
    <div className="table-wrap" role="region" aria-label="Leads" tabIndex={0}><table className="lt-table">
      <thead><tr><th className="lt-chk"><input type="checkbox" aria-label="Select all leads on this page" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map(r => r.id)))} /></th>{showDue && <th scope="col">Next</th>}<th scope="col" aria-sort={sort.by === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}><Link href={sort.name} className="srt">Lead name{arrow('name')}</Link></th><th scope="col">Phone</th><th scope="col">Stage</th>{on('email') && <th scope="col">Email</th>}{on('source') && <th scope="col">Source</th>}{on('notes') && <th scope="col">Notes</th>}{on('owner') && <th scope="col">Lead owner</th>}{on('updated') && <th scope="col" aria-sort={sort.by === 'updated' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}><Link href={sort.updated} className="srt">Modified{arrow('updated')}</Link></th>}</tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className={sel.has(r.id) ? 'sel' : undefined}>
        <td className="lt-chk"><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
        {showDue && <td>{r.due ? <span className={`due ${r.due.tone}`}>{r.due.text}</span> : null}</td>}
        <td><Link href={`/work/leads/${r.id}`} className="lt-name"><strong>{r.name}</strong></Link></td>
        <td>{r.hidden ? <span className="muted">Hidden</span> : <span className="lt-act">
          {r.phone ? <><span className="lt-ph">{r.phone}</span><a className="ic call" href={`tel:${r.phone}`} aria-label={`Call ${r.name}`} title="Call"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11 11 0 003.5.56 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.2.2 2.4.56 3.5a1 1 0 01-.25 1z"/></svg></a>
            <a className="ic wa" href={wa(r.phone)} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${r.name}`} title="WhatsApp">WA</a></> : <span className="muted">—</span>}
          {r.email && <a className="ic" href={`mailto:${r.email}`} aria-label={`Email ${r.name}`} title={r.email}>@</a>}</span>}</td>
        <td><select className="input lt-stage" aria-label={`Stage of ${r.name}`} value={r.stage} disabled={pending} onChange={e => run([r.id], { stage: e.target.value })}>{[...new Set([r.stage, ...stages])].map(s => <option key={s}>{s}</option>)}</select></td>
        {on('email') && <td>{r.hidden ? <span className="muted">Hidden</span> : r.email ? <a className="zlink" href={`mailto:${r.email}`}>{r.email}</a> : <span className="muted">—</span>}</td>}{on('source') && <td>{r.source}</td>}{on('notes') && <td className="lt-notes">{r.summary ?? ''}</td>}{on('owner') && <td>{r.owner}</td>}{on('updated') && <td className="muted">{r.ago}</td>}</tr>)}</tbody></table></div>
  </div>;
}
