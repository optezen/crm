'use client';
// Lead board. Moving a card calls the same server function as the lead page (crm_set_stage), so the database validates the stage, the caller's right to edit the
// lead and the stage's transition requirements. The card is only moved on screen after the server accepts it.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { COLOR_HEX } from '../../lib/builder/pipeline';
import type { StageSettings } from '../../lib/workspace/types';
import { moveLeadAction } from '../../app/(app)/work/leads/board/actions';

export type BoardLead = { id: string; stage: string; fullName: string; source: string; summary: string | null; assignee: string | null; openTasks: number };
export function KanbanBoard({ stages, settings, leads: initial, totals }: { stages: string[]; settings: Record<string, StageSettings>; leads: BoardLead[]; totals: Record<string, number> }) {
  const [leads, setLeads] = useState(initial); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [over, setOver] = useState<string | null>(null), [drag, setDrag] = useState<string | null>(null);
  const move = (id: string, stage: string) => { const cur = leads.find(l => l.id === id); if (!cur || cur.stage === stage) return;
    start(async () => { const r = await moveLeadAction(id, stage); if (!r.ok) { setMsg({ ok: false, text: `${cur.fullName}: ${r.error}` }); return; } setLeads(ls => ls.map(l => (l.id === id ? { ...l, stage } : l))); setMsg({ ok: true, text: `${cur.fullName} moved to ${stage}.` }); }); };
  return <div className="stack" style={{ gap: 10 }}>
    <div role="status" aria-live="polite">{msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}</div>
    <div className="kanban">{stages.map(st => { const col = leads.filter(l => l.stage === st); const set = settings[st] ?? {}; return <section key={st} className={`kanban-col${over === st ? ' over' : ''}`} style={{ ['--stage' as string]: COLOR_HEX[set.color ?? 'gray'] }} aria-label={`${st}, ${col.length} lead(s)`}
      onDragOver={e => { e.preventDefault(); setOver(st); }} onDragLeave={() => setOver(o => (o === st ? null : o))} onDrop={e => { e.preventDefault(); setOver(null); if (drag) move(drag, st); setDrag(null); }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>{st}</strong><span className="tag">{totals[st] ?? col.length}</span></div>
      {(set.requires_assignee || set.requires_summary) && <span className="muted" style={{ fontSize: 12 }}>Needs {[set.requires_assignee && 'an assignee', set.requires_summary && 'a summary'].filter(Boolean).join(' and ')}</span>}
      {col.map(l => <div key={l.id} className="kanban-card" draggable onDragStart={e => { setDrag(l.id); e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}>
        <Link href={`/work/leads/${l.id}`}><strong>{l.fullName}</strong></Link>
        <span className="muted" style={{ fontSize: 12 }}>{l.source.replace('_', ' ')}{l.assignee ? ` · ${l.assignee}` : ' · unassigned'}{l.openTasks ? ` · ${l.openTasks} open task(s)` : ''}</span>
        {l.summary && <span style={{ fontSize: 13 }}>{l.summary.length > 90 ? `${l.summary.slice(0, 90)}…` : l.summary}</span>}
        <label className="sr-only" htmlFor={`mv-${l.id}`}>Move {l.fullName} to</label>
        <select id={`mv-${l.id}`} className="input" style={{ minWidth: 0, padding: '4px 8px', fontSize: 13 }} value={l.stage} disabled={pending} onChange={e => move(l.id, e.target.value)}>{stages.map(s => <option key={s}>{s}</option>)}</select>
      </div>)}
      {col.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No leads</span>}
      {(totals[st] ?? 0) > col.length && <span className="muted" style={{ fontSize: 12 }}>Showing the latest {col.length} of {totals[st]}. Open the list to see all.</span>}
    </section>; })}</div>
  </div>;
}
