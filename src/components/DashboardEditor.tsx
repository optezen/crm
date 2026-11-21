'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { REPORTS } from '../lib/analytics/reports';
import { RANGES, WIDGET_TYPES, type QueryResult, type Agg, type Catalog, type CatalogSource, type Query, type Range, type Widget, type WidgetType } from '../lib/analytics/types';
import { saveDashboardAction, deleteDashboardAction, previewWidgetAction } from '../app/(app)/dashboards/actions';
import { Chart } from './charts';
import { commit, history, redo, seal, undo, type History } from '../lib/builder/history';
import { applyGridEdit, moveWidget, resizeFromDrag, GRID_GAP, ROW_H, type GridDraft } from '../lib/builder/dashboardGrid';

const AGGS: { value: Agg; label: string }[] = [{ value: 'count', label: 'Count' }, { value: 'count_distinct', label: 'Count distinct' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }];
const TYPE_LABEL: Record<WidgetType, string> = { kpi: 'KPI card', line: 'Line chart', bar: 'Bar chart', pie: 'Pie chart', table: 'Table', funnel: 'Funnel' };
const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
const first = (s: CatalogSource | undefined, p: (f: CatalogSource['fields'][number]) => boolean) => s?.fields.find(p);

/** Builds a validated-grammar query from form choices. The database re-validates it on save and on every run; nothing here is SQL. */
export function WidgetForm({ w, catalog, onChange }: { w: Widget; catalog: Catalog; onChange: (w: Widget) => void }) {
  const q = w.query; const src = catalog.sources.find(s => s.source === q.source); const dateFields = src?.fields.filter(f => f.type === 'date' || f.type === 'timestamp') ?? [];
  const setQ = (p: Partial<Query>) => onChange({ ...w, query: { ...q, ...p } });
  const g = q.group_by ?? []; const maxGroups = w.type === 'kpi' ? 0 : w.type === 'table' ? 2 : 1;
  const setType = (type: WidgetType) => { const lim = type === 'kpi' ? 0 : type === 'table' ? 2 : 1; let gb = g.slice(0, lim); if (lim > 0 && gb.length === 0 && src) { const f = first(src, x => x.groupable && x.type !== 'date' && x.type !== 'timestamp') ?? first(src, x => x.groupable); if (f) gb = [{ field: f.field, ...(f.type === 'date' || f.type === 'timestamp' ? { bucket: 'day' as const } : {}) }]; }
    if (type === 'line' && src) { const d = first(src, x => x.type === 'date' || x.type === 'timestamp'); if (d) gb = [{ field: d.field, bucket: 'day' }]; } onChange({ ...w, type, h: type === 'kpi' ? 2 : w.h, query: { ...q, group_by: gb } }); };
  const changeSource = (s: string) => { const ns = catalog.sources.find(x => x.source === s); const gf = first(ns, x => x.groupable && x.type !== 'date' && x.type !== 'timestamp'); onChange({ ...w, query: { source: s, metric: { agg: 'count' }, group_by: maxGroups && gf ? [{ field: gf.field }] : [] } }); };
  const needsField = q.metric.agg !== 'count'; const metricFields = src?.fields.filter(f => (q.metric.agg === 'count_distinct' ? true : q.metric.agg === 'min' || q.metric.agg === 'max' ? f.aggregatable : f.aggregatable && (f.type === 'number' || f.type === 'money'))) ?? [];
  const money = src?.fields.find(f => f.field === q.metric.field)?.type === 'money' && !src?.fields.find(f => f.field === q.metric.field)?.money_fixed;
  const filter = q.filters?.[0];
  return <div className="stack" style={{ gap: 8 }}>
    <div className="form-grid">
      <div className="field"><label>Shown as</label><select className="input" value={w.type} onChange={e => setType(e.target.value as WidgetType)}>{WIDGET_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></div>
      <div className="field"><label>Data</label><select className="input" value={q.source} onChange={e => changeSource(e.target.value)}>{catalog.sources.map(s => <option key={s.source} value={s.source}>{s.label}</option>)}</select></div>
      <div className="field"><label>Measure</label><select className="input" value={q.metric.agg} onChange={e => { const agg = e.target.value as Agg; setQ({ metric: agg === 'count' ? { agg } : { agg, field: metricFields[0]?.field } }); }}>{AGGS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}</select></div>
      {needsField && <div className="field"><label>of</label><select className="input" value={q.metric.field ?? ''} onChange={e => setQ({ metric: { agg: q.metric.agg, field: e.target.value } })}>{metricFields.map(f => <option key={f.field} value={f.field}>{f.label}</option>)}</select></div>}
      {Array.from({ length: maxGroups }, (_, i) => { const cur = g[i]; const f = src?.fields.find(x => x.field === cur?.field); const isDate = f?.type === 'date' || f?.type === 'timestamp';
        return <div className="field" key={i}><label>Group by{maxGroups > 1 ? ` (${i + 1})` : ''}</label><div className="inline"><select className="input" value={cur?.field ?? ''} onChange={e => { const nf = src?.fields.find(x => x.field === e.target.value); const next = [...g]; next[i] = { field: e.target.value, ...(nf && (nf.type === 'date' || nf.type === 'timestamp') ? { bucket: 'day' as const } : {}) }; setQ({ group_by: next.filter(Boolean) }); }}>
          {i > 0 && <option value="">None</option>}{src?.fields.filter(x => x.groupable).map(x => <option key={x.field} value={x.field}>{x.label}</option>)}</select>
          {isDate && <select className="input" aria-label="Bucket" value={cur?.bucket ?? 'day'} onChange={e => { const next = [...g]; next[i] = { field: cur!.field, bucket: e.target.value as 'day' | 'week' | 'month' }; setQ({ group_by: next }); }}><option value="day">per day</option><option value="week">per week</option><option value="month">per month</option></select>}</div></div>; })}
      <div className="field"><label>Date field</label><select className="input" value={q.date?.field ?? ''} onChange={e => setQ({ date: e.target.value ? { field: e.target.value, range: q.date?.range ?? 'last_30_days' } : undefined })}><option value="">No date limit</option>{dateFields.map(f => <option key={f.field} value={f.field}>{f.label}</option>)}</select></div>
      {q.date && <div className="field"><label>Range</label><select className="input" value={q.date.range} onChange={e => setQ({ date: { field: q.date!.field, range: e.target.value as Range } })}>{RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>}
    </div>
    <div className="inline"><span className="muted">Filter</span>
      <select className="input" aria-label="Filter field" value={filter?.field ?? ''} onChange={e => setQ({ filters: e.target.value ? [{ field: e.target.value, op: 'eq', value: '' }] : undefined })}><option value="">None</option>{src?.fields.filter(f => f.filterable && f.type !== 'uuid').map(f => <option key={f.field} value={f.field}>{f.label}</option>)}</select>
      {filter && <><select className="input" aria-label="Filter operator" value={filter.op} onChange={e => setQ({ filters: [{ ...filter, op: e.target.value as (typeof FILTER_OPS)[number] }] })}>{FILTER_OPS.map(o => <option key={o} value={o}>{o}</option>)}</select>
        <input className="input" aria-label="Filter value" style={{ width: 160 }} value={String(filter.value ?? '')} onChange={e => { const f = src?.fields.find(x => x.field === filter.field); const raw = e.target.value; const v = f?.type === 'number' || f?.type === 'money' ? (raw === '' ? '' : Number(raw)) : f?.type === 'bool' ? raw === 'true' : raw; setQ({ filters: [{ ...filter, value: v as string | number | boolean }] }); }} placeholder={src?.fields.find(x => x.field === filter.field)?.type === 'bool' ? 'true / false' : 'value'} /></>}</div>
    {money && !g.some(x => x.field === 'currency') && !(q.filters ?? []).some(x => x.field === 'currency' && x.op === 'eq') && <p className="err" role="alert">Amounts in different currencies are never combined: group by Currency or filter to one currency.</p>}
  </div>;
}

type Preview = { state: 'loading' } | { state: 'ok'; result: QueryResult } | { state: 'err'; code: string; error: string };

/** Drag-and-drop dashboard layout. Widgets flow in order across a 12-column grid; position = order, size = columns x rows (the same fields dashboards already persist),
 * so a layout made here, by the AI or in the old form is identical. Previews run as the signed-in user, so they can never show data the user may not see. */
export function DashboardEditor({ id, initial, catalog, canShare, proposalId = null, banner = null, stages, planRef = null }: { id: string | null; initial: { name: string; description: string; visibility: 'personal' | 'organization'; version: number | null; widgets: Widget[] }; catalog: Catalog; canShare: boolean; proposalId?: string | null; banner?: string | null; stages?: string[]; planRef?: { plan: string; step: string } | null }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [h, setH] = useState<History<GridDraft>>(() => history({ name: initial.name, description: initial.description, visibility: initial.visibility, widgets: initial.widgets }));
  const d = h.present; const [sel, setSel] = useState<number | null>(null); const [tpl, setTpl] = useState('');
  const [saved, setSaved] = useState(() => JSON.stringify(h.present)); const dirty = JSON.stringify(d) !== saved || !id;
  const [version, setVersion] = useState(initial.version); const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const gridRef = useRef<HTMLDivElement>(null); const [dragFrom, setDragFrom] = useState<number | null>(null); const [dragOver, setDragOver] = useState<number | null>(null);
  const available = REPORTS.filter(r => catalog.sources.some(s => s.source === r.query.source));
  const edit = (next: GridDraft, key: string | null = null) => setH(c => commit(c, next, key));
  const setWidgets = (widgets: Widget[], key: string | null = null) => edit({ ...d, widgets }, key);

  // live previews, keyed by the query so unchanged widgets are never re-run
  const qkey = (w: Widget) => JSON.stringify(w.query); const keys = d.widgets.map(qkey).join('|');
  useEffect(() => {
    const t = setTimeout(() => { for (const w of d.widgets) { const k = qkey(w); if (previews[k]) continue; setPreviews(p => ({ ...p, [k]: { state: 'loading' } }));
      previewWidgetAction(w.query).then(r => setPreviews(p => ({ ...p, [k]: r.ok ? { state: 'ok', result: r.result } : { state: 'err', code: r.code, error: r.error } }))); } }, 350);
    return () => clearTimeout(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  const add = (w: Widget) => { setWidgets([...d.widgets, w]); setSel(d.widgets.length); };
  const addBlank = () => { const s = catalog.sources[0]; if (s) add({ type: 'kpi', title: 'New widget', query: { source: s.source, metric: { agg: 'count' } }, w: 3, h: 2 }); };
  const addReport = (key: string) => { const r = available.find(x => x.key === key); if (!r) return; const type: WidgetType = r.chart; add({ type, title: r.title, query: structuredClone(r.query), w: type === 'kpi' ? 3 : type === 'table' ? 12 : 6, h: type === 'kpi' ? 2 : 4 }); setTpl(''); };
  const patch = (i: number, w: Widget, key: string | null = null) => { setWidgets(d.widgets.map((x, j) => (j === i ? w : x)), key); };
  const remove = (i: number) => { setWidgets(d.widgets.filter((_, j) => j !== i)); setSel(null); };
  const relocate = (from: number, to: number) => { const r = moveWidget(d.widgets, from, to); if (r !== d.widgets) { setWidgets(r); setSel(to); } };
  const save = () => start(async () => {
    const r = await saveDashboardAction(id, { name: d.name, description: d.description, visibility: d.visibility, widgets: d.widgets, version }, proposalId, planRef);
    if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
    setSaved(JSON.stringify(d)); setVersion(r.version); setMsg({ ok: true, text: 'Saved.' }); if (!id) router.replace(`/dashboards/${r.id}?edit=1`);
  });

  // resize by dragging the corner; the grid cell size is measured from the live grid so it matches what is drawn
  const resize = useRef<{ i: number; sx: number; sy: number; w: number; h: number } | null>(null);
  const resizeDown = (e: React.PointerEvent, i: number) => { e.stopPropagation(); e.preventDefault(); const w = d.widgets[i]!; resize.current = { i, sx: e.clientX, sy: e.clientY, w: w.w, h: w.h }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setSel(i); };
  const resizeMove = (e: React.PointerEvent) => { const r = resize.current, g = gridRef.current; if (!r || !g) return; const colW = (g.clientWidth - GRID_GAP * 11) / 12; const n = resizeFromDrag(r, e.clientX - r.sx, e.clientY - r.sy, colW); const cur = d.widgets[r.i]; if (cur && (cur.w !== n.w || cur.h !== n.h)) patch(r.i, { ...cur, ...n }, `resize:${r.i}`); };
  const resizeUp = () => { resize.current = null; setH(c => seal(c)); };
  const tileKey = (e: React.KeyboardEvent, i: number) => {
    const w = d.widgets[i]!; const k = e.key;
    if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowUp')) { e.preventDefault(); relocate(i, i - 1); }
    else if (e.altKey && (k === 'ArrowRight' || k === 'ArrowDown')) { e.preventDefault(); relocate(i, i + 1); }
    else if (e.shiftKey && k.startsWith('Arrow')) { e.preventDefault(); const n = applyGridEdit(w, k); patch(i, { ...w, ...n }, `resize:${i}`); }
  };

  return <div className="stack" style={{ gap: 12 }}>
    {banner && <p className="notice" role="note">{banner}</p>}
    <div className="studio-bar">
      <button type="button" className="btn" disabled={!h.past.length} onClick={() => setH(c => undo(seal(c)))}>Undo</button>
      <button type="button" className="btn" disabled={!h.future.length} onClick={() => setH(c => redo(c))}>Redo</button>
      <button type="button" className="btn primary" disabled={pending || !d.name.trim() || !dirty} onClick={save}>{pending ? 'Saving…' : 'Save dashboard'}</button>
      <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      {id && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Delete this dashboard?')) start(async () => { const r = await deleteDashboardAction(id); if (r.ok) router.push('/dashboards'); else setMsg({ ok: false, text: r.error ?? 'Could not delete.' }); }); }}>Delete</button>}
      {msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}
    </div>
    <div className="studio">
      <aside className="studio-pane" aria-label="Widget palette">
        <h2>Add a widget</h2>
        <button type="button" className="btn" disabled={d.widgets.length >= 24 || catalog.sources.length === 0} onClick={addBlank}>Blank widget</button>
        <select className="input" aria-label="Add from the report library" style={{ width: '100%' }} value={tpl} onChange={e => addReport(e.target.value)}><option value="">From the report library…</option>{available.map(r => <option key={r.key} value={r.key}>{r.group}: {r.title}</option>)}</select>
        {catalog.sources.length === 0 && <p className="muted">No data sources are available to your role.</p>}
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Drag a tile to reorder it, drag its corner to resize. Keyboard: focus a tile, Alt+arrows to move it, Shift+arrows to resize.</p>
        <h2>Dashboard</h2>
        <div className="field"><label htmlFor="dn">Name</label><input id="dn" className="input" value={d.name} maxLength={80} onChange={e => edit({ ...d, name: e.target.value }, 'name')} /></div>
        <div className="field"><label htmlFor="dd">Description</label><input id="dd" className="input" value={d.description} maxLength={300} onChange={e => edit({ ...d, description: e.target.value }, 'desc')} /></div>
        <div className="field"><label htmlFor="dv">Who can see it</label><select id="dv" className="input" value={d.visibility} onChange={e => edit({ ...d, visibility: e.target.value as 'personal' | 'organization' })}><option value="personal">Only me</option>{(canShare || d.visibility === 'organization') && <option value="organization">Everyone in the organization</option>}</select>
          <span className="hint">Each widget runs with the permissions of whoever is looking at the dashboard: sharing never shares data someone may not see.</span></div>
      </aside>
      <section aria-label="Dashboard layout" className="stack" style={{ gap: 8 }}>
        {d.widgets.length === 0 && <p className="empty">No widgets yet. Add one from the palette.</p>}
        <div className="grid12" ref={gridRef} onClick={e => { if (e.target === e.currentTarget) setSel(null); }}>
          {d.widgets.map((w, i) => { const p = previews[qkey(w)]; return <div key={i} role="button" tabIndex={0} aria-pressed={sel === i} aria-label={`${w.title}, ${w.type}, ${w.w} columns by ${w.h} rows. Alt plus arrows moves it, Shift plus arrows resizes it.`}
            className={`grid-item${sel === i ? ' sel' : ''}${dragOver === i && dragFrom !== null && dragFrom !== i ? ' drop' : ''}`} style={{ gridColumn: `span ${w.w}`, gridRow: `span ${w.h}` }} draggable
            onDragStart={e => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }} onDragOver={e => { if (dragFrom !== null) { e.preventDefault(); setDragOver(i); } }}
            onDrop={e => { e.preventDefault(); if (dragFrom !== null) relocate(dragFrom, i); setDragFrom(null); setDragOver(null); }} onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
            onClick={() => setSel(i)} onFocus={() => setSel(i)} onKeyDown={e => tileKey(e, i)}>
            <strong style={{ fontSize: 13 }}>{w.title}</strong>
            <div style={{ height: `calc(100% - 22px)`, overflow: 'hidden' }}>{!p || p.state === 'loading' ? <p className="muted" style={{ fontSize: 12 }}>Loading preview…</p>
              : p.state === 'ok' ? <Chart type={w.type} result={p.result} funnelOrder={w.type === 'funnel' && w.query.source === 'leads' && w.query.group_by?.[0]?.field === 'stage' ? stages : undefined} />
              : <p className={p.code === 'forbidden' ? 'muted' : 'err'} style={{ fontSize: 12 }} role="status">{p.code === 'forbidden' ? `No access: ${p.error}` : p.error}</p>}</div>
            <button type="button" className="grid-resize" aria-label={`Resize ${w.title}`} tabIndex={-1} onPointerDown={e => resizeDown(e, i)} onPointerMove={resizeMove} onPointerUp={resizeUp} />
          </div>; })}
        </div>
      </section>
      <aside className="studio-pane" aria-label="Widget properties">
        <h2>{sel !== null && d.widgets[sel] ? 'Widget properties' : 'Properties'}</h2>
        {sel === null || !d.widgets[sel] ? <p className="muted">Select a widget to change what it shows, its size and its place.</p> : (() => { const w = d.widgets[sel]!; return <div className="stack" style={{ gap: 10 }}>
          <div className="field"><label htmlFor="wt">Title</label><input id="wt" className="input" value={w.title} maxLength={80} onChange={e => patch(sel, { ...w, title: e.target.value }, `title:${sel}`)} /></div>
          <div className="inline">
            <div className="field"><label htmlFor="ww">Columns (1-12)</label><input id="ww" className="input" style={{ width: 80 }} type="number" min={1} max={12} value={w.w} onChange={e => patch(sel, { ...w, w: Math.min(12, Math.max(1, Number(e.target.value) || 1)) }, `w:${sel}`)} /></div>
            <div className="field"><label htmlFor="wh">Rows (1-12)</label><input id="wh" className="input" style={{ width: 80 }} type="number" min={1} max={12} value={w.h} onChange={e => patch(sel, { ...w, h: Math.min(12, Math.max(1, Number(e.target.value) || 1)) }, `h:${sel}`)} /></div></div>
          <WidgetForm w={w} catalog={catalog} onChange={nw => patch(sel, nw)} />
          <div className="row"><button type="button" className="btn" disabled={sel === 0} onClick={() => relocate(sel, sel - 1)}>Move earlier</button><button type="button" className="btn" disabled={sel === d.widgets.length - 1} onClick={() => relocate(sel, sel + 1)}>Move later</button>
            <button type="button" className="btn" disabled={d.widgets.length >= 24} onClick={() => add(structuredClone({ ...w, id: undefined, title: `${w.title} (copy)` }))}>Duplicate</button><button type="button" className="btn" onClick={() => remove(sel)}>Remove</button></div>
        </div>; })()}
      </aside>
    </div>
  </div>;
}
