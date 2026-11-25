'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { bulkLeadsAction } from '../../app/(app)/work/leads/actions';

export type LeadRowView = { id: string; name: string; summary: string | null; phone: string | null; email: string | null; hidden: boolean; stage: string; source: string; owner: string; ago: string; tasks: number; due: { text: string; tone: string } | null };
const initials = (n: string) => n.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
const wa = (p: string) => `https://wa.me/${p.replace(/\D/g, '')}`;

/** The working list: tabs and filters live on the page; this handles selection, in-place stage change and bulk actions. */
export function LeadsTable({ rows, stages, owners, manager }: { rows: LeadRowView[]; stages: string[]; owners: { id: string; label: string }[]; manager: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set()); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null); const [pending, start] = useTransition();
  const all = rows.length > 0 && sel.size === rows.length;
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = (ids: string[], op: { stage?: string; assignee?: string | null }) => start(async () => {
    const r = await bulkLeadsAction(ids, op); setMsg({ ok: !r?.error, text: r?.error ?? r?.ok ?? '' }); if (!r?.error) setSel(new Set());
  });
  if (rows.length === 0) return null;
  return <div className="lt">
    {sel.size > 0 && <div className="lt-bulk" role="region" aria-label="Bulk actions"><strong>{sel.size} selected</strong>
      <select className="input" aria-label="Move selected to stage" defaultValue="" disabled={pending} onChange={e => { if (e.target.value) { run([...sel], { stage: e.target.value }); e.target.value = ''; } }}><option value="">Move to stage…</option>{stages.map(s => <option key={s}>{s}</option>)}</select>
      {manager && <select className="input" aria-label="Assign selected to" defaultValue="" disabled={pending} onChange={e => { if (e.target.value) { run([...sel], { assignee: e.target.value === '__none' ? null : e.target.value }); e.target.value = ''; } }}><option value="">Assign to…</option><option value="__none">Unassigned</option>{owners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}
      <button className="btn" onClick={() => setSel(new Set())}>Clear</button></div>}
    {msg && <p className={msg.ok ? 'ok' : 'err'} role="status">{msg.text}</p>}
    <div className="table-wrap" role="region" aria-label="Leads" tabIndex={0}><table className="lt-table">
      <thead><tr><th className="lt-chk"><input type="checkbox" aria-label="Select all leads on this page" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map(r => r.id)))} /></th><th scope="col">Next</th><th scope="col">Lead</th><th scope="col">Phone</th><th scope="col">Stage</th><th scope="col">Owner</th><th scope="col">Updated</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className={sel.has(r.id) ? 'sel' : undefined}>
        <td className="lt-chk"><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
        <td>{r.due ? <span className={`due ${r.due.tone}`}>{r.due.text}</span> : null}</td>
        <td><Link href={`/work/leads/${r.id}`} className="lt-name"><span className="lt-av" aria-hidden>{initials(r.name)}</span><span><strong>{r.name}</strong><small className="muted">{r.source}</small></span></Link></td>
        <td>{r.hidden ? <span className="muted">Hidden</span> : <span className="lt-act">
          {r.phone ? <><span className="lt-ph">{r.phone}</span><a className="ic call" href={`tel:${r.phone}`} aria-label={`Call ${r.name}`} title="Call"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11 11 0 003.5.56 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.2.2 2.4.56 3.5a1 1 0 01-.25 1z"/></svg></a>
            <a className="ic wa" href={wa(r.phone)} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${r.name}`} title="WhatsApp">WA</a></> : <span className="muted">—</span>}
          {r.email && <a className="ic" href={`mailto:${r.email}`} aria-label={`Email ${r.name}`} title={r.email}>@</a>}</span>}</td>
        <td><select className="input lt-stage" aria-label={`Stage of ${r.name}`} value={r.stage} disabled={pending} onChange={e => run([r.id], { stage: e.target.value })}>{[...new Set([r.stage, ...stages])].map(s => <option key={s}>{s}</option>)}</select></td>
        <td>{r.owner}</td><td className="muted">{r.ago}</td></tr>)}</tbody></table></div>
  </div>;
}
