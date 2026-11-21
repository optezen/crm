'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { REPORTS } from '../lib/analytics/reports';
import { RANGES, WIDGET_TYPES, type Agg, type Catalog, type CatalogSource, type Query, type Range, type Widget, type WidgetType } from '../lib/analytics/types';
import { saveDashboardAction, deleteDashboardAction } from '../app/(app)/dashboards/actions';

const AGGS: { value: Agg; label: string }[] = [{ value: 'count', label: 'Count' }, { value: 'count_distinct', label: 'Count distinct' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }];
const TYPE_LABEL: Record<WidgetType, string> = { kpi: 'KPI card', line: 'Line chart', bar: 'Bar chart', pie: 'Pie chart', table: 'Table', funnel: 'Funnel' };
const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
const first = (s: CatalogSource | undefined, p: (f: CatalogSource['fields'][number]) => boolean) => s?.fields.find(p);

/** Builds a validated-grammar query from form choices. The database re-validates it on save and on every run; nothing here is SQL. */
function WidgetForm({ w, catalog, onChange }: { w: Widget; catalog: Catalog; onChange: (w: Widget) => void }) {
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

export function DashboardEditor({ id, initial, catalog, canShare }: { id: string | null; initial: { name: string; description: string; visibility: 'personal' | 'organization'; version: number | null; widgets: Widget[] }; catalog: Catalog; canShare: boolean }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [name, setName] = useState(initial.name), [desc, setDesc] = useState(initial.description), [vis, setVis] = useState(initial.visibility), [ws, setWs] = useState<Widget[]>(initial.widgets); const [tpl, setTpl] = useState('');
  const available = REPORTS.filter(r => catalog.sources.some(s => s.source === r.query.source));
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= ws.length) return; const n = [...ws]; [n[i], n[j]] = [n[j]!, n[i]!]; setWs(n); };
  const addBlank = () => { const s = catalog.sources[0]; if (!s) return; setWs([...ws, { type: 'kpi', title: 'New widget', query: { source: s.source, metric: { agg: 'count' } }, w: 3, h: 2 }]); };
  const addReport = (key: string) => { const r = available.find(x => x.key === key); if (!r) return; const type: WidgetType = r.chart; setWs([...ws, { type, title: r.title, query: structuredClone(r.query), w: type === 'kpi' ? 3 : type === 'table' ? 12 : 6, h: type === 'kpi' ? 2 : 4 }]); setTpl(''); };
  const save = () => start(async () => { const r = await saveDashboardAction(id, { name, description: desc, visibility: vis, widgets: ws, version: initial.version }); if (!r.ok) setMsg({ ok: false, text: r.error }); else router.push(`/dashboards/${r.id}`); });
  return <div className="stack">
    <div className="form-grid">
      <div className="field"><label htmlFor="dn">Name</label><input id="dn" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="dd">Description</label><input id="dd" className="input" value={desc} maxLength={300} onChange={e => setDesc(e.target.value)} /></div>
      <div className="field"><label htmlFor="dv">Who can see it</label><select id="dv" className="input" value={vis} onChange={e => setVis(e.target.value as 'personal' | 'organization')}><option value="personal">Only me</option>{(canShare || vis === 'organization') && <option value="organization">Everyone in the organization</option>}</select></div></div>
    <p className="muted">Each widget runs with the permissions of whoever is looking at the dashboard: sharing a dashboard never shares data someone is not allowed to see.</p>
    {ws.map((w, i) => <div key={i} className="card" style={{ padding: 16 }}><div className="stack" style={{ gap: 10 }}>
      <div className="inline"><div className="field" style={{ flex: 2 }}><label htmlFor={`wt${i}`}>Title</label><input id={`wt${i}`} className="input" value={w.title} maxLength={80} onChange={e => setWs(ws.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></div>
        <div className="field"><label htmlFor={`ww${i}`}>Width (1-12)</label><input id={`ww${i}`} className="input" style={{ width: 80 }} type="number" min={1} max={12} value={w.w} onChange={e => setWs(ws.map((x, j) => (j === i ? { ...x, w: Math.min(12, Math.max(1, Number(e.target.value) || 1)) } : x)))} /></div>
        <div className="field"><label htmlFor={`wh${i}`}>Height (1-12)</label><input id={`wh${i}`} className="input" style={{ width: 80 }} type="number" min={1} max={12} value={w.h} onChange={e => setWs(ws.map((x, j) => (j === i ? { ...x, h: Math.min(12, Math.max(1, Number(e.target.value) || 1)) } : x)))} /></div></div>
      <WidgetForm w={w} catalog={catalog} onChange={nw => setWs(ws.map((x, j) => (j === i ? nw : x)))} />
      <div className="row"><button type="button" className="btn" disabled={i === 0} onClick={() => move(i, -1)}>Move earlier</button><button type="button" className="btn" disabled={i === ws.length - 1} onClick={() => move(i, 1)}>Move later</button><button type="button" className="btn" onClick={() => setWs(ws.filter((_, j) => j !== i))}>Remove widget</button></div></div></div>)}
    <div className="row"><button type="button" className="btn" disabled={ws.length >= 24 || catalog.sources.length === 0} onClick={addBlank}>Add widget</button>
      <select className="input" aria-label="Add from the report library" style={{ width: 'auto' }} value={tpl} onChange={e => addReport(e.target.value)}><option value="">Add from the report library…</option>{available.map(r => <option key={r.key} value={r.key}>{r.group}: {r.title}</option>)}</select></div>
    {catalog.sources.length === 0 && <p className="muted">No data sources are available to your role.</p>}
    <div className="row"><button type="button" className="btn primary" disabled={pending || !name.trim()} onClick={save}>{pending ? 'Saving…' : 'Save dashboard'}</button>
      {id && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Delete this dashboard?')) start(async () => { const r = await deleteDashboardAction(id); if (r.ok) router.push('/dashboards'); else setMsg({ ok: false, text: r.error ?? 'Could not delete.' }); }); }}>Delete</button>}
      {msg && <span role="alert" className="err">{msg.text}</span>}</div>
  </div>;
}
