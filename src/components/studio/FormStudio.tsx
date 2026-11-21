'use client';
// Visual form builder. It edits the module's field list in the workspace configuration DRAFT (the same draft the Builder and the AI use) and saves through
// the same validation. Field keys are permanent: only label, help text, section, order, options and the required/hidden flags change, so stored records are untouched.
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FIELD_KIND_LABEL, FIELD_DESC_MAX, FIELD_SECTION_MAX, DEFAULT_CURRENCY, type FieldConfig, type FieldKind, type WorkspaceConfig } from '../../lib/workspace/types';
import { diffConfig, validateConfig } from '../../lib/workspace/schema';
import { FIELD_PALETTE, insertField, lockedKeys, moveField, newField, removeField, renameSection, sectionRuns, updateField } from '../../lib/builder/forms';
import { commit, history, redo, seal, undo, type History } from '../../lib/builder/history';
import { FormFields } from '../ui/FormFields';
import { discardAction, publishAction, saveVisualConfigAction } from '../../app/(app)/builder/actions';

export function FormStudio({ published, draft, token: initToken, publishedRev: initRev, proposalNote }: { published: WorkspaceConfig; draft: WorkspaceConfig | null; token: string; publishedRev: number | null; proposalNote: string | null }) {
  const router = useRouter(); const [pending, start] = useTransition();
  const [h, setH] = useState<History<WorkspaceConfig>>(() => history(draft ?? published));
  const cfg = h.present;
  const editable = cfg.objects.filter(o => cfg.modules.some(m => m.key === o.key && m.status !== 'archived'));
  const [objKey, setObjKey] = useState(editable[0]?.key ?? '');
  const obj = cfg.objects.find(o => o.key === objKey) ?? null;
  const pubObj = published.objects.find(o => o.key === objKey);
  const locked = useMemo(() => lockedKeys(pubObj?.fields), [pubObj]);
  const [sel, setSel] = useState<string | null>(null);
  const [token, setToken] = useState(initToken), [rev, setRev] = useState(initRev), [hasDraft, setHasDraft] = useState(!!draft);
  const [saved, setSaved] = useState(() => JSON.stringify(draft ?? published));
  const [msg, setMsg] = useState<{ ok: boolean; text: string; conflict?: boolean }>();
  const [dragFrom, setDragFrom] = useState<number | null>(null), [dragOver, setDragOver] = useState<number | null>(null);
  const [newSection, setNewSection] = useState('');

  const valid = useMemo(() => validateConfig(cfg), [cfg]);
  const changes = useMemo(() => (valid.ok ? diffConfig(published, valid.value) : []), [valid, published]);
  const dirty = JSON.stringify(cfg) !== saved;
  const fields = obj?.fields ?? [];
  const selIdx = fields.findIndex(f => f.key === sel); const f = selIdx >= 0 ? fields[selIdx]! : null;
  const setFields = (next: FieldConfig[], key: string | null = null) => { if (!obj) return; setH(c => commit(c, { ...c.present, objects: c.present.objects.map(o => (o.key === obj.key ? { ...o, fields: next } : o)) }, key)); };
  const patch = (key: string, p: Partial<FieldConfig>, ck: string | null = null) => setFields(updateField(fields, key, p), ck);
  const add = (kind: FieldKind, at?: number) => { const nf = newField(fields, kind, FIELD_KIND_LABEL[kind], at !== undefined ? (fields[at - 1] ?? fields[at])?.section : fields[fields.length - 1]?.section); const next = insertField(fields, nf, at); if (next !== fields) { setFields(next); setSel(nf.key); } else setMsg({ ok: false, text: 'A record type can have at most 30 fields.' }); };
  const relocate = (from: number, to: number) => { const n = moveField(fields, from, to); if (n !== fields) { setFields(n); setSel(fields[from]!.key); } };
  const run = (fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string; conflict?: boolean }>, after?: (r: { ok: true; message: string }) => void) => start(async () => { const r = await fn(); setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error, conflict: 'conflict' in r ? r.conflict : undefined }); if (r.ok) after?.(r); });
  const save = () => { if (!valid.ok) return; run(() => saveVisualConfigAction(valid.value, token, rev), (r) => { const x = r as { token?: string; published?: number | null }; if (x.token) setToken(x.token); if (x.published !== undefined) setRev(x.published); setSaved(JSON.stringify(cfg)); setHasDraft(true); }); };
  const canPublish = hasDraft && !dirty && valid.ok && changes.length > 0 && !pending;
  const visible = fields.filter(x => !x.archived);
  const sections = [...new Set(fields.map(x => x.section).filter(Boolean))] as string[];

  if (!editable.length) return <div className="notice"><strong>No custom modules yet</strong>Create a module in <a href="/builder">Modules &amp; settings</a>, then design its form here.</div>;
  return <div className="stack" style={{ gap: 12 }}>
    {proposalNote && <p className="notice" role="note">{proposalNote}</p>}
    <div className="studio-bar">
      <div className="field"><label htmlFor="fs-obj" className="sr-only">Module</label><select id="fs-obj" className="input" value={objKey} onChange={e => { setObjKey(e.target.value); setSel(null); }}>{editable.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</select></div>
      <button type="button" className="btn" disabled={!h.past.length} onClick={() => setH(c => undo(seal(c)))}>Undo</button>
      <button type="button" className="btn" disabled={!h.future.length} onClick={() => setH(c => redo(c))}>Redo</button>
      <button type="button" className="btn primary" disabled={pending || !valid.ok || !dirty} onClick={save}>Save draft</button>
      <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">{dirty ? 'Unsaved changes' : hasDraft ? 'Draft saved (not live)' : 'No changes'}{!valid.ok ? ' · has problems' : ''}</span>
    </div>
    <div className="studio">
      <aside className="studio-pane" aria-label="Field palette">
        <h2>Add a field</h2><p className="muted" style={{ fontSize: 12, margin: 0 }}>Drag onto the form, or press Add.</p>
        {FIELD_PALETTE.map(p => <div key={p.kind} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <div className="palette-item" draggable onDragStart={e => { e.dataTransfer.setData('application/x-optizen-field', p.kind); e.dataTransfer.effectAllowed = 'copy'; }}>{p.label}</div>
          <button type="button" className="btn" aria-label={`Add ${p.label} field`} onClick={() => add(p.kind)}>Add</button></div>)}
      </aside>

      <section aria-label="Form" className="stack" style={{ gap: 10 }}
        onDragOver={e => { if (e.dataTransfer.types.includes('application/x-optizen-field')) e.preventDefault(); }}
        onDrop={e => { const k = e.dataTransfer.getData('application/x-optizen-field'); if (k) { e.preventDefault(); add(k as FieldKind, dragOver ?? undefined); setDragOver(null); } }}>
        <div className="studio-pane">
          {fields.length === 0 && <p className="empty">No fields yet. Add one from the palette.</p>}
          {sectionRuns(fields).map((run2, ri) => <div key={`${ri}-${run2.section}`} className="stack" style={{ gap: 6 }}>
            {run2.section ? <div className="row"><input className="input" style={{ maxWidth: 260, fontWeight: 600 }} aria-label={`Section name: ${run2.section}`} defaultValue={run2.section} maxLength={FIELD_SECTION_MAX} onBlur={e => { if (e.target.value.trim() !== run2.section) setFields(renameSection(fields, run2.section, e.target.value)); }} /><span className="muted" style={{ fontSize: 12 }}>section heading (shown to people filling the form)</span></div>
              : ri > 0 ? <span className="muted" style={{ fontSize: 12 }}>No section heading</span> : null}
            {run2.fields.map(x => { const i = fields.findIndex(y => y.key === x.key); return <div key={x.key} role="button" tabIndex={0} aria-pressed={sel === x.key} draggable
              aria-label={`${x.label}, ${FIELD_KIND_LABEL[x.kind]}${x.required ? ', required' : ''}${x.archived ? ', hidden' : ''}. Alt plus up or down arrow moves it.`}
              className={`form-canvas-field${sel === x.key ? ' sel' : ''}${dragOver === i && dragFrom !== i ? ' drop' : ''}`} style={x.archived ? { opacity: .55 } : undefined}
              onClick={() => setSel(x.key)} onFocus={() => setSel(x.key)}
              onKeyDown={e => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); relocate(i, i - 1); } else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); relocate(i, i + 1); } }}
              onDragStart={e => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.key); }} onDragOver={e => { e.preventDefault(); setDragOver(i); }}
              onDrop={e => { const k = e.dataTransfer.getData('application/x-optizen-field'); if (k) { e.preventDefault(); e.stopPropagation(); add(k as FieldKind, i); } else if (dragFrom !== null) { e.preventDefault(); e.stopPropagation(); relocate(dragFrom, i); } setDragFrom(null); setDragOver(null); }} onDragEnd={() => { setDragFrom(null); setDragOver(null); }}>
              <span aria-hidden style={{ cursor: 'grab' }}>⠿</span><div style={{ flex: 1, minWidth: 0 }}><strong>{x.label}</strong>{x.required && <span aria-hidden> *</span>} <span className="tag">{FIELD_KIND_LABEL[x.kind]}</span>{x.archived && <span className="tag">Hidden</span>}
                {x.description && <div className="muted" style={{ fontSize: 12 }}>{x.description}</div>}</div></div>; })}
          </div>)}
        </div>
        <details open><summary>Preview: the form people fill in (Work Mode)</summary>
          {visible.length ? <FormFields fields={visible} disabled idPrefix="pv-" /> : <p className="muted">No visible fields.</p>}
        </details>
      </section>

      <aside className="studio-pane" aria-label="Field properties">
        <h2>{f ? 'Field properties' : 'Properties'}</h2>
        {!f && <p className="muted">Select a field to edit its label, help text, section and options. Keys are permanent so existing records are never affected.</p>}
        {f && <>
          <div className="field"><label htmlFor="fp-label">Label</label><input id="fp-label" className="input" value={f.label} maxLength={60} onChange={e => patch(f.key, { label: e.target.value }, `label:${f.key}`)} /><span className="hint">Permanent identifier: <code>{f.key}</code></span></div>
          <div className="field"><label htmlFor="fp-kind">Type</label><select id="fp-kind" className="input" value={f.kind} disabled={locked.has(f.key)} onChange={e => patch(f.key, { kind: e.target.value as FieldKind })}>{FIELD_PALETTE.map(p => <option key={p.kind} value={p.kind}>{p.label}</option>)}</select>
            {locked.has(f.key) && <span className="hint">Locked: records may already use this field. Hide it and add a new one to change the type.</span>}</div>
          <div className="field"><label htmlFor="fp-desc">Help text</label><input id="fp-desc" className="input" value={f.description ?? ''} maxLength={FIELD_DESC_MAX} onChange={e => patch(f.key, { description: e.target.value }, `desc:${f.key}`)} /></div>
          <div className="field"><label htmlFor="fp-sec">Section</label><input id="fp-sec" className="input" list="fp-secs" value={f.section ?? ''} maxLength={FIELD_SECTION_MAX} onChange={e => patch(f.key, { section: e.target.value.replace(/\s+/g, ' ') }, `sec:${f.key}`)} /><datalist id="fp-secs">{sections.map(s => <option key={s} value={s} />)}</datalist>
            <span className="hint">Neighbouring fields with the same section share one heading.</span></div>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!f.required} disabled={!!f.archived || f.kind === 'yes_no'} onChange={e => patch(f.key, { required: e.target.checked })} /> Required</label>
          {f.kind === 'choice' && <div className="field"><label htmlFor="fp-opts">Dropdown options (one per line)</label><textarea id="fp-opts" className="input" rows={5} defaultValue={(f.options ?? []).join('\n')} key={f.key} onBlur={e => patch(f.key, { options: [...new Set(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))].slice(0, 30) })} />
            <span className="hint">Removing an option never changes values already stored.</span></div>}
          {f.kind === 'currency' && <div className="field"><label htmlFor="fp-cur">Currency code</label><input id="fp-cur" className="input" style={{ width: 90 }} value={f.currency ?? DEFAULT_CURRENCY} maxLength={3} onChange={e => patch(f.key, { currency: e.target.value.toUpperCase() })} /></div>}
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn" disabled={selIdx === 0} onClick={() => relocate(selIdx, selIdx - 1)}>Move up</button><button type="button" className="btn" disabled={selIdx === fields.length - 1} onClick={() => relocate(selIdx, selIdx + 1)}>Move down</button>
            <button type="button" className="btn" onClick={() => patch(f.key, { archived: !f.archived })}>{f.archived ? 'Show' : 'Hide'}</button>
            {!locked.has(f.key) && <button type="button" className="btn" onClick={() => { setFields(removeField(fields, f.key)); setSel(null); }}>Remove</button>}</div>
          <div className="inline"><div className="field"><label htmlFor="fp-new-sec" className="sr-only">New section name</label><input id="fp-new-sec" className="input" placeholder="New section name" value={newSection} maxLength={FIELD_SECTION_MAX} onChange={e => setNewSection(e.target.value)} /></div>
            <button type="button" className="btn" disabled={!newSection.trim()} onClick={() => { patch(f.key, { section: newSection.trim() }); setNewSection(''); }}>Start section here</button></div>
        </>}
      </aside>
    </div>

    <div className="studio-pane" aria-label="Review and publish">
      <h2>Review and publish</h2>
      {!valid.ok && <div role="alert" className="err"><strong>Fix before saving:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{valid.errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      {valid.ok && (changes.length === 0 ? <p className="muted">No changes compared with the live version.</p> : <div><strong>Changes compared with the live version</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{changes.map(c => <li key={c}>{c}</li>)}</ul></div>)}
      <div className="row">
        <button type="button" className="btn primary" disabled={!canPublish} onClick={() => { if (confirm('Publish this version? It becomes the live form for everyone.')) run(() => publishAction(), () => { router.refresh(); }); }}>Publish draft</button>
        <button type="button" className="btn" disabled={pending || !hasDraft} onClick={() => { if (confirm('Discard the saved draft?')) run(() => discardAction(), () => router.refresh()); }}>Discard draft</button>
      </div>
      {dirty && <p className="muted">Save the draft to enable publishing.</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.conflict && <button type="button" className="btn" onClick={() => location.reload()}>Reload latest</button>}</p>}
    </div>
  </div>;
}
