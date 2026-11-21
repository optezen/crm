'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CORE_MODULES, DEFAULT_CURRENCY, FIELD_KINDS, FIELD_KIND_LABEL, type FieldConfig, type FieldKind, type ModuleStatus, type ObjectConfig, type WorkspaceConfig } from '../../../lib/workspace/types';
import { diffConfig, fieldSlug, slug, uniqueKey, validateConfig } from '../../../lib/workspace/schema';
import type { VersionRow } from '../../../lib/workspace/builder';
import { Card } from '../../../components/ui/Card';
import { FieldInput } from '../../../components/ui/FieldInput';
import { LocalTime } from '../../../components/ui/LocalTime';
import { OperationsSettings } from './OperationsSettings';
import { aiDraftBuilderAction, discardAction, publishAction, restoreAction, saveDraftAction, saveVisualConfigAction, type BuilderResult } from './actions';

const isCore = (key: string) => CORE_MODULES.some(c => c.key === key);
const norm = (c: WorkspaceConfig) => { const v = validateConfig(c); return v.ok ? JSON.stringify(v.value) : JSON.stringify(c); };
const STATUS_LABEL: Record<ModuleStatus, string> = { active: 'Active', planned: 'Planned (no screens)', archived: 'Hidden' };
const newObject = (key: string, label: string): ObjectConfig => ({ key, label, fields: [{ key: 'name', label: 'Name', kind: 'text', required: true }] });

/** Field list for one record type. Published fields keep their type (records may use it) and can be hidden but not removed. */
export function FieldsEditor({ obj, pub, onChange }: { obj: ObjectConfig; pub?: ObjectConfig; onChange: (o: ObjectConfig) => void }) {
  const [name, setName] = useState(''), [kind, setKind] = useState<FieldKind>('text');
  const setField = (i: number, patch: Partial<FieldConfig>) => onChange({ ...obj, fields: obj.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const clean = (f: FieldConfig): FieldConfig => { const { options, currency, ...rest } = f; return { ...rest, ...(f.kind === 'choice' ? { options: options?.length ? options : ['Option 1'] } : {}), ...(f.kind === 'currency' ? { currency: currency ?? DEFAULT_CURRENCY } : {}) }; };
  return <div className="stack" style={{ gap: 10 }}>
    {obj.fields.map((f, i) => { const locked = pub?.fields.some(p => p.key === f.key); return <div className="inline" key={f.key} style={f.archived ? { opacity: .6 } : undefined}>
      <div className="field"><input className="input" aria-label={`${obj.label} field ${i + 1} name`} value={f.label} maxLength={60} onChange={e => setField(i, { label: e.target.value })} /></div>
      <select className="input" aria-label={`${f.label} type`} value={f.kind} disabled={locked} title={locked ? 'The type cannot change once published, because records may use it. Hide this field and add a new one.' : undefined}
        onChange={e => setObjField(i, e.target.value as FieldKind)}>{FIELD_KINDS.map(k => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}</select>
      {f.kind === 'choice' && <div className="field"><input className="input" aria-label={`${f.label} dropdown options, comma separated`} placeholder="Options, comma separated" defaultValue={(f.options ?? []).join(', ')} onBlur={e => setField(i, { options: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} /></div>}
      {f.kind === 'currency' && <div className="field"><input className="input" style={{ width: 90 }} aria-label={`${f.label} currency code`} value={f.currency ?? DEFAULT_CURRENCY} maxLength={3} onChange={e => setField(i, { currency: e.target.value.toUpperCase() })} /></div>}
      <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!f.required} disabled={!!f.archived} onChange={e => setField(i, { required: e.target.checked || undefined })} /> Required</label>
      <button type="button" className="btn" onClick={() => setField(i, { archived: f.archived ? undefined : true })}>{f.archived ? 'Show' : 'Hide'}</button>
      {!locked && <button type="button" className="btn" onClick={() => onChange({ ...obj, fields: obj.fields.filter((_, j) => j !== i) })}>Remove</button>}
    </div>; })}
    <div className="inline"><div className="field"><input className="input" aria-label={`New field name for ${obj.label}`} placeholder="New field, e.g. Registration Number" value={name} maxLength={60} onChange={e => setName(e.target.value)} /></div>
      <select className="input" aria-label="New field type" value={kind} onChange={e => setKind(e.target.value as FieldKind)}>{FIELD_KINDS.map(k => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}</select>
      <button type="button" className="btn" disabled={!name.trim() || obj.fields.length >= 30} onClick={() => { const label = name.trim().replace(/\s+/g, ' '); onChange({ ...obj, fields: [...obj.fields, clean({ key: uniqueKey(fieldSlug(label), obj.fields.map(f => f.key), '_'), label, kind })] }); setName(''); }}>Add field</button></div>
    <details><summary>Preview the form</summary>
      {obj.fields.some(f => !f.archived) ? <div className="form-grid" style={{ marginTop: 8 }}>{obj.fields.filter(f => !f.archived).map(f => <FieldInput key={f.key} field={f} disabled idPrefix={`pv-${obj.key}-`} />)}</div> : <p className="muted">No visible fields.</p>}</details>
  </div>;
  function setObjField(i: number, k: FieldKind) { onChange({ ...obj, fields: obj.fields.map((f, j) => (j === i ? clean({ ...f, kind: k }) : f)) }); }
}

export function BuilderEditor({ published, draft, aiAvailable, versions, token: initToken = null, publishedRev: initRev = null }: { published: WorkspaceConfig; draft: WorkspaceConfig | null; aiAvailable: boolean; versions: VersionRow[]; token?: string | null; publishedRev?: number | null }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<WorkspaceConfig>(draft ?? published);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; conflict?: boolean }>();
  const [token, setToken] = useState(initToken), [rev, setRev] = useState(initRev);
  const [pending, start] = useTransition();
  const [newModule, setNewModule] = useState(''), [newStage, setNewStage] = useState(''), [aiText, setAiText] = useState(published.description ?? '');

  const valid = useMemo(() => validateConfig(cfg), [cfg]);
  const changes = useMemo(() => (valid.ok ? diffConfig(published, valid.value) : []), [valid, published]);
  const savedKey = draft ? norm(draft) : null;
  const dirty = norm(cfg) !== (savedKey ?? norm(published));
  const canPublish = !!draft && !dirty && valid.ok && changes.length > 0;
  const pubModules = new Set(published.modules.map(m => m.key));
  const moduleKeys = new Set(cfg.modules.map(m => m.key));
  const orphans = cfg.objects.filter(o => !moduleKeys.has(o.key));
  const liveRevision = versions.find(v => v.status === 'published')?.revision;

  const set = (patch: Partial<WorkspaceConfig>) => setCfg(c => ({ ...c, ...patch }));
  const setObject = (o: ObjectConfig) => set({ objects: cfg.objects.some(x => x.key === o.key) ? cfg.objects.map(x => (x.key === o.key ? o : x)) : [...cfg.objects, o] });
  const setStatus = (i: number, status: ModuleStatus) => {
    const m = cfg.modules[i]!;
    const objects = status === 'active' && !cfg.objects.some(o => o.key === m.key) ? [...cfg.objects, newObject(m.key, m.label)] : cfg.objects; // an active module needs a record type to hold data
    set({ modules: cfg.modules.map((x, j) => (j === i ? { ...x, status } : x)), objects });
  };
  const move = (i: number, d: number) => { const s = [...cfg.pipeline.stages]; const j = i + d; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j]!, s[i]!]; set({ pipeline: { stages: s } }); };
  const run = (fn: () => Promise<BuilderResult>, after?: () => void) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { after?.(); router.refresh(); } });
  // Saved with a conflict check: refused when the draft or the live version changed since this page loaded (another tab, another admin, an AI plan), and nothing is overwritten.
  const saveChecked = () => start(async () => {
    if (!valid.ok) return;
    if (token === null) { const r = await saveDraftAction(valid.value); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) router.refresh(); return; }
    const r = await saveVisualConfigAction(valid.value, token, rev);
    if (r.ok) { setToken(r.token); setRev(r.published); setMsg({ ok: true, text: r.message }); router.refresh(); } else setMsg({ ok: false, text: r.error, conflict: r.conflict });
  });
  const askAi = () => start(async () => {
    const r = await aiDraftBuilderAction(aiText);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setCfg({ ...r.value, businessName: published.businessName }); setMsg({ ok: true, text: 'AI draft loaded into the editor. Review it, save it as a draft, then publish. Nothing is live yet.' });
  });

  return <div className="stack">
    <Card title="Modules" description="Overview and Leads are the core of every workspace. Add your own modules, such as Vehicles or Orders, and define the fields people fill in.">
      <div className="stack" style={{ gap: 16 }}>
        {cfg.modules.map((m, i) => { const o = cfg.objects.find(x => x.key === m.key); return <div key={m.key} className="stack" style={{ gap: 8 }}>
          <div className="inline">
            <div className="field"><input className="input" aria-label={`Module name for ${m.label}`} value={m.label} disabled={isCore(m.key)} maxLength={60} onChange={e => set({ modules: cfg.modules.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /></div>
            {isCore(m.key) ? <span className="tag">Core</span> : <>
              <select className="input" aria-label={`${m.label} status`} value={m.status} onChange={e => setStatus(i, e.target.value as ModuleStatus)}>{(Object.keys(STATUS_LABEL) as ModuleStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
              {!pubModules.has(m.key) && <button type="button" className="btn" onClick={() => set({ modules: cfg.modules.filter((_, j) => j !== i), objects: cfg.objects.filter(x => x.key !== m.key || pubModules.has(x.key)) })}>Remove</button>}</>}
          </div>
          {!isCore(m.key) && (o
            ? <details><summary>Fields ({o.fields.filter(f => !f.archived).length})</summary><FieldsEditor obj={o} pub={published.objects.find(x => x.key === m.key)} onChange={setObject} /></details>
            : <p className="muted">No fields yet. <button type="button" className="btn" onClick={() => setObject(newObject(m.key, m.label))}>Add a record type</button></p>)}
        </div>; })}
        <div className="inline"><div className="field"><input className="input" aria-label="New module name" placeholder="New module, e.g. Vehicles" value={newModule} maxLength={60} onChange={e => setNewModule(e.target.value)} /></div>
          <button type="button" className="btn" disabled={!newModule.trim() || cfg.modules.length >= 40} onClick={() => { const label = newModule.trim().replace(/\s+/g, ' '); const key = uniqueKey(slug(label), [...cfg.modules.map(m => m.key), ...cfg.objects.map(o => o.key)]); set({ modules: [...cfg.modules, { key, label, status: 'active' }], objects: [...cfg.objects, newObject(key, label)] }); setNewModule(''); }}>Add module</button></div>
      </div>
    </Card>

    {orphans.length > 0 && <Card title="Record types without a module" description="These definitions exist but no module shows them yet.">
      <div className="stack">{orphans.map(o => <div key={o.key} className="stack" style={{ gap: 8 }}>
        <div className="row"><strong>{o.label}</strong>
          <button type="button" className="btn" onClick={() => set({ modules: [...cfg.modules, { key: o.key, label: o.label, status: 'active' }] })}>Create module</button>
          {!published.objects.some(x => x.key === o.key) && <button type="button" className="btn" onClick={() => set({ objects: cfg.objects.filter(x => x.key !== o.key) })}>Remove</button>}</div>
        <FieldsEditor obj={o} pub={published.objects.find(x => x.key === o.key)} onChange={setObject} /></div>)}</div>
    </Card>}

    <OperationsSettings cfg={cfg} published={published} onChange={operations => set({ operations })} />

    <Card title="Lead pipeline" description="Stages a lead moves through, in order. A stage can only be removed when no lead is in it; move those leads first.">
      <div className="stack" style={{ gap: 8 }}>
        {cfg.pipeline.stages.map((s, i) => <div className="inline" key={i}>
          <div className="field"><input className="input" aria-label={`Stage ${i + 1}`} value={s} maxLength={80} onChange={e => set({ pipeline: { stages: cfg.pipeline.stages.map((x, j) => (j === i ? e.target.value : x)) } })} /></div>
          <button type="button" className="btn" aria-label={`Move stage ${s} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="btn" aria-label={`Move stage ${s} down`} disabled={i === cfg.pipeline.stages.length - 1} onClick={() => move(i, 1)}>↓</button>
          <button type="button" className="btn" disabled={cfg.pipeline.stages.length <= 2} onClick={() => set({ pipeline: { stages: cfg.pipeline.stages.filter((_, j) => j !== i) } })}>Remove</button>
        </div>)}
        <div className="inline"><div className="field"><input className="input" aria-label="New stage name" placeholder="New stage" value={newStage} maxLength={80} onChange={e => setNewStage(e.target.value)} /></div>
          <button type="button" className="btn" disabled={!newStage.trim() || cfg.pipeline.stages.length >= 20} onClick={() => { set({ pipeline: { stages: [...cfg.pipeline.stages, newStage.trim().replace(/\s+/g, ' ')] } }); setNewStage(''); }}>Add stage</button></div>
      </div>
    </Card>

    <Card title="Review and publish" description={draft ? 'A saved draft exists. Publishing makes exactly the saved draft live as a new version.' : 'Save your edits as a draft, review the changes, then publish.'}>
      <div className="stack">
        {!valid.ok && <div role="alert" className="err"><strong>Fix before saving:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{valid.errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
        {valid.ok && (changes.length === 0 ? <p className="muted">No changes compared with the live version.</p>
          : <div><strong>Changes compared with the live version</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{changes.map(c => <li key={c}>{c}</li>)}</ul></div>)}
        {dirty && <p className="muted">You have unsaved edits. Save the draft to review it and enable publishing.</p>}
        <div className="row">
          <button type="button" className="btn primary" disabled={pending || !valid.ok || !dirty} onClick={saveChecked}>Save draft</button>
          <button type="button" className="btn" disabled={pending || !canPublish} onClick={() => { if (confirm('Publish this version? It becomes the live workspace configuration for everyone.')) run(publishAction, () => setMsg(undefined)); }}>Publish draft</button>
          <button type="button" className="btn" disabled={pending || (!dirty && !draft)} onClick={() => { if (draft) run(discardAction, () => setCfg(published)); else setCfg(published); }}>{draft ? 'Discard draft' : 'Reset edits'}</button>
        </div>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.conflict && <button type="button" className="btn" onClick={() => location.reload()}>Reload latest</button>}</p>}
      </div>
    </Card>

    <Card title="Version history and rollback" description="Published versions are immutable. Restoring an old version loads it as a draft for review; data your records use is kept, and publishing it creates a new version.">
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} className="stack">{versions.map(v => <li key={v.revision} className="inline">
        <span>Version {v.revision} · {v.status === 'published' ? 'Live' : v.status === 'draft' ? 'Draft' : 'Archived'} · <LocalTime iso={v.createdAt} /></span>
        {v.status === 'archived' && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm(`Load version ${v.revision} as your draft? Your current draft, if any, is replaced.`)) run(() => restoreAction(v.revision)); }}>Restore as draft</button>}
        {v.revision === liveRevision && <span className="tag">Live</span>}</li>)}</ul>
    </Card>

    <Card title="Draft with AI" description="Describe the business and let a model propose modules, a pipeline and record types. The proposal only fills the editor above.">
      {aiAvailable
        ? <div className="stack"><div className="field"><label htmlFor="ai-desc">What does your business do?</label><textarea id="ai-desc" className="input" value={aiText} maxLength={1000} onChange={e => setAiText(e.target.value)} /></div>
            <div><button type="button" className="btn" disabled={pending} onClick={askAi}>{pending ? 'Working…' : 'Propose a configuration'}</button></div></div>
        : <p className="muted">AI drafting is not configured on this deployment (no model API key is set), so it is not offered. Everything else in the Builder works without it.</p>}
    </Card>
  </div>;
}
