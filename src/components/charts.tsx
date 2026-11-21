import type { Column, QueryResult } from '../lib/analytics/types';

// Dependency-free SVG charts. They draw exactly the rows the database returned: no smoothing, no estimates, no placeholder values. Colors follow the Optizen palette.
type Row = QueryResult['rows'][number];
const PALETTE = ['#1f4d43', '#c2762b', '#4f6d9a', '#8a5a83', '#b8a042', '#5a9a8a', '#a64d4d', '#6b6560'];
const num = (v: unknown) => Number(v ?? 0);
const label = (r: Row, c: Column | undefined) => String((c?.user ? r[`${c.key}_label`] : undefined) ?? r[c?.key ?? 'g1'] ?? '(none)');
const fmt = (v: number) => (Math.abs(v) >= 1000 ? new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' }).format(v) : String(Math.round(v * 100) / 100));
const full = (v: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(v);

export function Kpi({ result }: { result: QueryResult }) {
  const v = result.rows[0]?.value; const empty = v === null || v === undefined;
  return <div role="img" aria-label={`${result.columns.at(-1)?.label}: ${empty ? 'no data' : full(num(v))}`}><div style={{ fontSize: 34, fontWeight: 650, letterSpacing: '-.02em' }}>{empty ? '—' : full(num(v))}</div><div className="muted" style={{ fontSize: 13 }}>{result.columns.at(-1)?.label}{empty && ' · no data in this range'}</div></div>;
}
export function BarChart({ result }: { result: QueryResult }) {
  const c = result.columns[0]; const rows = result.rows.slice(0, 20); const max = Math.max(1, ...rows.map(r => num(r.value)));
  return <div className="stack" style={{ gap: 6 }} role="list" aria-label={`${result.columns.at(-1)?.label} by ${c?.label}`}>{rows.map((r, i) => <div key={i} role="listitem" style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 30%) 1fr auto', gap: 8, alignItems: 'center', fontSize: 13 }}>
    <span title={label(r, c)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(r, c)}</span>
    <svg height="14" width="100%" preserveAspectRatio="none" viewBox="0 0 100 14" aria-hidden><rect x="0" y="2" height="10" width={Math.max(0.5, (num(r.value) / max) * 100)} rx="2" fill={PALETTE[0]} /></svg><strong>{full(num(r.value))}</strong></div>)}</div>;
}
export function FunnelChart({ result, order }: { result: QueryResult; order?: string[] }) {
  const c = result.columns[0]; let rows = [...result.rows]; if (order) rows = order.map(o => rows.find(r => r.g1 === o) ?? { g1: o, value: 0 }); const max = Math.max(1, ...rows.map(r => num(r.value)));
  return <div className="stack" style={{ gap: 4 }} role="list">{rows.map((r, i) => <div key={i} role="listitem" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: 13 }}><div style={{ width: `${Math.max(8, (num(r.value) / max) * 100)}%`, background: PALETTE[0], opacity: 1 - i * 0.08, color: '#fff', borderRadius: 4, padding: '4px 8px', textAlign: 'center', minWidth: 90 }}>{label(r, c)} · <strong>{full(num(r.value))}</strong></div></div>)}</div>;
}
export function PieChart({ result }: { result: QueryResult }) {
  const c = result.columns[0]; const rows = result.rows.slice(0, 12); const total = rows.reduce((s, r) => s + Math.max(0, num(r.value)), 0);
  if (total <= 0) return <p className="muted">No data in this range.</p>;
  let a0 = -Math.PI / 2; const R = 48;
  return <div className="row" style={{ alignItems: 'flex-start' }}><svg viewBox="-50 -50 100 100" width="150" height="150" role="img" aria-label={`${result.columns.at(-1)?.label} by ${c?.label}`}>{rows.map((r, i) => { const f = Math.max(0, num(r.value)) / total; if (f <= 0) return null; const a1 = a0 + f * 2 * Math.PI; const large = f > 0.5 ? 1 : 0;
    const d = f >= 0.9999 ? `M0,-${R} A${R},${R} 0 1 1 0,${R} A${R},${R} 0 1 1 0,-${R}Z` : `M0,0 L${R * Math.cos(a0)},${R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${R * Math.cos(a1)},${R * Math.sin(a1)}Z`; a0 = a1; return <path key={i} d={d} fill={PALETTE[i % PALETTE.length]} stroke="#fff" strokeWidth="0.8" />; })}</svg>
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13 }}>{rows.map((r, i) => <li key={i} className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, background: PALETTE[i % PALETTE.length], borderRadius: 2, display: 'inline-block' }} aria-hidden />{label(r, c)}: <strong>{full(num(r.value))}</strong> <span className="muted">({Math.round((num(r.value) / total) * 100)}%)</span></li>)}</ul></div>;
}
export function LineChart({ result }: { result: QueryResult }) {
  const c = result.columns[0]; const rows = [...result.rows].sort((a, b) => String(a.g1).localeCompare(String(b.g1))); if (rows.length === 0) return <p className="muted">No data in this range.</p>;
  const vals = rows.map(r => num(r.value)); const max = Math.max(1, ...vals), W = 300, H = 110, P = 6; const x = (i: number) => (rows.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (rows.length - 1)), y = (v: number) => H - P - (v / max) * (H - 2 * P);
  return <div><svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${result.columns.at(-1)?.label} by ${c?.label}`}><polyline fill="none" stroke={PALETTE[0]} strokeWidth="2" points={rows.map((r, i) => `${x(i)},${y(num(r.value))}`).join(' ')} />{rows.map((r, i) => <circle key={i} cx={x(i)} cy={y(num(r.value))} r="2.5" fill={PALETTE[0]}><title>{`${r.g1}: ${full(num(r.value))}`}</title></circle>)}</svg>
    <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12 }}><span>{String(rows[0]!.g1)}</span><span>max {fmt(max)}</span><span>{String(rows.at(-1)!.g1)}</span></div></div>;
}
export function DataTable2({ result }: { result: QueryResult }) {
  return <div className="table-wrap" role="region" aria-label={result.definition} tabIndex={0}><table><thead><tr>{result.columns.map(c => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
    <tbody>{result.rows.map((r, i) => <tr key={i}>{result.columns.map(c => <td key={c.key}>{c.key === 'value' ? full(num(r.value)) : label(r, c)}</td>)}</tr>)}</tbody></table>{result.rows.length === 0 && <p className="empty">No data in this range.</p>}</div>;
}
export function Chart({ type, result, funnelOrder }: { type: string; result: QueryResult; funnelOrder?: string[] }) {
  if (type === 'kpi') return <Kpi result={result} />;
  if (result.rows.length === 0 && type !== 'table') return <p className="muted">No data in this range.</p>;
  switch (type) { case 'bar': return <BarChart result={result} />; case 'line': return <LineChart result={result} />; case 'pie': return <PieChart result={result} />; case 'funnel': return <FunnelChart result={result} order={funnelOrder} />; default: return <DataTable2 result={result} />; }
}
