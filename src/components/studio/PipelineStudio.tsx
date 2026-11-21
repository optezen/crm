'use client';
// Visual pipeline editor on the workspace configuration draft. Renames and removals are recorded as a migration plan that the database applies atomically at publish;
// a stage that still holds leads cannot be removed without choosing where they go.
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { STAGE_COLORS, type StageColor, type WorkspaceConfig } from '../../lib/workspace/types';
import { diffConfig, validateConfig } from '../../lib/workspace/schema';
import { COLOR_HEX, addRow, modelFromPipeline, moveRow, patchRow, pipelineFromModel, removeRow, setTarget, unplanned, type PipelineModel } from '../../lib/builder/pipeline';
import { commit, history, redo, seal, undo, type History } from '../../lib/builder/history';
import { discardAction, publishAction, saveVisualConfigAction } from '../../app/(app)/builder/actions';

export function PipelineStudio({ published, draft, token: initToken, publishedRev: initRev, counts }: { published: WorkspaceConfig; draft: WorkspaceConfig | null; token: string; publishedRev: number | null; counts: Record<string, number> }) {
  const router = useRouter(); const [pending, start] = useTransition();
  const base = draft ?? published;
  const [h, setH] = useState<History<PipelineModel>>(() => history(modelFromPipeline(base.pipeline, published.pipeline)));
  const m = h.present; const set = (n: PipelineModel, key: string | null = null) => setH(c => commit(c, n, key));
  const [token, setToken] = useState(initToken), [rev, setRev] = useState(initRev), [hasDraft, setHasDraft] = useState(!!draft);
  const cfg: WorkspaceConfig = useMemo(() => ({ ...base, pipeline: pipelineFromModel(m) }), [base, m]);
  const [saved, setSaved] = useState(() => JSON.stringify(pipelineFromModel(h.present)));
  const [msg, setMsg] = useState<{ ok: boolean; text: string; conflict?: boolean }>();
  const [name, setName] = useState(''); const [dragFrom, setDragFrom] = useState<number | null>(null), [dragOver, setDragOver] = useState<number | null>(null);
  const valid = useMemo(() => validateConfig(cfg), [cfg]);
  const blockers = useMemo(() => unplanned(m, counts), [m, counts]);
  const changes = useMemo(() => (valid.ok ? diffConfig(published, valid.value) : []), [valid, published]);
  const dirty = JSON.stringify(cfg.pipeline) !== saved;
  const save = () => { if (!valid.ok || blockers.length) return; start(async () => { const r = await saveVisualConfigAction(valid.value, token, rev); setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error, conflict: r.conflict }); if (r.ok) { setToken(r.token); setRev(r.published); setSaved(JSON.stringify(cfg.pipeline)); setHasDraft(true); } }); };
  const run = (fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) => start(async () => { const r = await fn(); setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error }); if (r.ok) router.refresh(); });
  const canPublish = hasDraft && !dirty && valid.ok && !blockers.length && changes.length > 0 && !pending;
  const dup = (i: number) => m.rows.some((r, j) => j !== i && r.name.trim() === m.rows[i]!.name.trim());

  return <div className="stack" style={{ gap: 12 }}>
    <div className="studio-bar">
      <button type="button" className="btn" disabled={!h.past.length} onClick={() => setH(c => undo(seal(c)))}>Undo</button>
      <button type="button" className="btn" disabled={!h.future.length} onClick={() => setH(c => redo(c))}>Redo</button>
      <button type="button" className="btn primary" disabled={pending || !valid.ok || blockers.length > 0 || !dirty} onClick={save}>Save draft</button>
      <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">{dirty ? 'Unsaved changes' : hasDraft ? 'Draft saved (not live)' : 'No changes'}</span>
    </div>
    <div className="studio" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
      <section aria-label="Stages" className="stack" style={{ gap: 8 }}>
        <div className="kanban" aria-hidden="true">{m.rows.map(r => <div key={r.key} className="kanban-col" style={{ ['--stage' as string]: COLOR_HEX[r.color ?? 'gray'], minHeight: 0, padding: '6px 10px' }}><strong style={{ fontSize: 13 }}>{r.name || '…'}</strong></div>)}</div>
        {m.rows.map((r, i) => <div key={r.key} className={`form-canvas-field${dragOver === i && dragFrom !== i ? ' drop' : ''}`} style={{ flexWrap: 'wrap', borderLeft: `6px solid ${COLOR_HEX[r.color ?? 'gray']}` }} draggable
          onDragStart={e => { setDragFrom(i); e.dataTransfer.setData('text/plain', r.key); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={e => { e.preventDefault(); setDragOver(i); }}
          onDrop={e => { e.preventDefault(); if (dragFrom !== null) set({ ...m, rows: moveRow(m.rows, dragFrom, i) }); setDragFrom(null); setDragOver(null); }} onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
          onKeyDown={e => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); set({ ...m, rows: moveRow(m.rows, i, i - 1) }); } else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); set({ ...m, rows: moveRow(m.rows, i, i + 1) }); } }}>
          <span aria-hidden style={{ cursor: 'grab' }}>⠿</span>
          <div className="field" style={{ flex: '1 1 180px' }}><label className="sr-only" htmlFor={`st-${r.key}`}>Stage {i + 1} name</label><input id={`st-${r.key}`} className="input" value={r.name} maxLength={80} aria-invalid={!r.name.trim() || dup(i)} onChange={e => set(patchRow(m, r.key, { name: e.target.value }), `n:${r.key}`)} />
            {r.liveName && r.liveName !== r.name.trim() && <span className="hint">Renamed from “{r.liveName}”: its {counts[r.liveName] ?? 0} lead(s) move automatically when you publish.</span>}{dup(i) && <span className="err">Stage names must be unique.</span>}</div>
          <select className="input" aria-label={`${r.name} colour`} value={r.color ?? 'gray'} onChange={e => set(patchRow(m, r.key, { color: e.target.value as StageColor }))}>{STAGE_COLORS.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!r.requires_assignee} onChange={e => set(patchRow(m, r.key, { requires_assignee: e.target.checked || undefined }))} /> Needs an assignee</label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!r.requires_summary} onChange={e => set(patchRow(m, r.key, { requires_summary: e.target.checked || undefined }))} /> Needs a summary</label>
          <span className="tag">{r.liveName ? `${counts[r.liveName] ?? 0} lead(s)` : 'new'}</span>
          <button type="button" className="btn" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => set({ ...m, rows: moveRow(m.rows, i, i - 1) })}>↑</button>
          <button type="button" className="btn" aria-label={`Move ${r.name} down`} disabled={i === m.rows.length - 1} onClick={() => set({ ...m, rows: moveRow(m.rows, i, i + 1) })}>↓</button>
          <button type="button" className="btn" disabled={m.rows.length <= 2} onClick={() => set(removeRow(m, r.key))}>Remove</button>
        </div>)}
        <div className="inline"><div className="field"><label htmlFor="ns" className="sr-only">New stage</label><input id="ns" className="input" placeholder="New stage" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
          <button type="button" className="btn" disabled={!name.trim() || m.rows.length >= 20} onClick={() => { set(addRow(m, name)); setName(''); }}>Add stage</button></div>
        {m.removed.length > 0 && <div className="studio-pane"><h2>Removed stages</h2>{m.removed.map(x => <div key={x.liveName} className="inline"><span><strong>{x.liveName}</strong> <span className="tag">{counts[x.liveName] ?? 0} lead(s)</span></span>
          <div className="field"><label htmlFor={`rt-${x.liveName}`}>Move its leads to</label><select id={`rt-${x.liveName}`} className="input" value={x.targetKey ?? ''} onChange={e => set(setTarget(m, x.liveName, e.target.value || null))}><option value="">{(counts[x.liveName] ?? 0) > 0 ? 'Choose a stage…' : 'No leads, nothing to move'}</option>{m.rows.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}</select></div></div>)}</div>}
      </section>
      <aside className="studio-pane" aria-label="How this works">
        <h2>Rules</h2>
        <p className="muted" style={{ margin: 0 }}>Stages run in the order shown. Colours are display only. “Needs an assignee / summary” is enforced by the database whenever a lead is moved into that stage, from the lead page, the board or an automation.</p>
        <p className="muted" style={{ margin: 0 }}>Renaming or removing a stage never loses leads: publishing moves them as planned, records a history entry on each lead, and refuses if any would be left behind.</p>
        <p className="muted" style={{ margin: 0 }}>Keyboard: Alt+↑/↓ in a stage row reorders it.</p>
      </aside>
    </div>
    <div className="studio-pane" aria-label="Review and publish"><h2>Review and publish</h2>
      {blockers.map(b => <p key={b} role="alert" className="err">{b}</p>)}
      {!valid.ok && <div role="alert" className="err"><strong>Fix before saving:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{valid.errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      {valid.ok && (changes.length === 0 ? <p className="muted">No changes compared with the live version.</p> : <div><strong>Changes compared with the live version</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{changes.map(c => <li key={c}>{c}</li>)}</ul></div>)}
      <div className="row"><button type="button" className="btn primary" disabled={!canPublish} onClick={() => { if (confirm('Publish this pipeline? Leads in renamed or removed stages are moved as planned.')) run(() => publishAction()); }}>Publish draft</button>
        <button type="button" className="btn" disabled={pending || !hasDraft} onClick={() => { if (confirm('Discard the saved draft?')) run(() => discardAction()); }}>Discard draft</button></div>
      {dirty && <p className="muted">Save the draft to enable publishing.</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.conflict && <button type="button" className="btn" onClick={() => location.reload()}>Reload latest</button>}</p>}
    </div>
  </div>;
}
