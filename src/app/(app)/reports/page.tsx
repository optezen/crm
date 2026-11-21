import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { runQuery } from '../../../lib/analytics/service';
import { REPORTS, REPORT_GROUPS } from '../../../lib/analytics/reports';
import { RANGES, type Query, type Range } from '../../../lib/analytics/types';
import { Card } from '../../../components/ui/Card';
import { Chart, DataTable2 } from '../../../components/charts';

export default async function Reports({ searchParams }: { searchParams: Promise<{ r?: string; range?: string }> }) {
  const sp = await searchParams; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const report = REPORTS.find(x => x.key === sp.r); const range = RANGES.find(x => x.value === sp.range)?.value as Range | undefined;
  const tz = s.config.operations?.appointments?.timezone ?? 'UTC';
  let body = null;
  if (report) {
    const q: Query = { ...structuredClone(report.query), tz, ...(report.query.date && range ? { date: { ...report.query.date, range } } : {}) };
    const res = await runQuery(await supabaseServer(), s.organizationId, q);
    body = <Card title={report.title} description={report.definition}>
      {res.ok ? <div className="stack"><Chart type={report.chart} result={res.result} funnelOrder={report.key === 'lead_funnel' ? s.config.pipeline.stages : undefined} />{report.chart !== 'table' && report.chart !== 'kpi' && <DataTable2 result={res.result} />}
        <p className="muted" style={{ fontSize: 12 }}>Measured: {res.result.definition}. Time zone: {tz}.</p>
        <div className="row"><a className="btn" href={`/api/reports/export?r=${report.key}${range ? `&range=${range}` : ''}`}>Download CSV</a><span className="muted" style={{ fontSize: 12 }}>Exports need the export permission and are logged.</span></div></div>
        : <p className={res.code === 'forbidden' ? 'muted' : 'err'} role="alert">{res.code === 'forbidden' ? `Your role does not have access to this report. ${res.error}` : res.error}</p>}</Card>;
  }
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Reports</h1><p className="muted">Every report states exactly what it measures. Numbers are computed from your records, under your permissions: you only see what your role may see.</p></div><Link className="btn" href="/dashboards">Dashboards</Link></div>
    <div className="shell-reports" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 24, alignItems: 'start' }}>
      <nav aria-label="Reports" className="stack" style={{ gap: 16 }}>{REPORT_GROUPS.map(g => <div key={g}><span className="eyebrow">{g}</span><div className="stack" style={{ gap: 2, marginTop: 6 }}>{REPORTS.filter(x => x.group === g).map(x => <Link key={x.key} href={`/reports?r=${x.key}`} aria-current={x.key === sp.r ? 'page' : undefined} style={{ padding: '6px 8px', borderRadius: 8, textDecoration: 'none', background: x.key === sp.r ? '#ecf2ef' : undefined, fontWeight: x.key === sp.r ? 600 : 400 }}>{x.title}</Link>)}</div></div>)}</nav>
      <div className="stack">{report && report.query.date && <form className="row" action="/reports"><input type="hidden" name="r" value={report.key} /><label htmlFor="rg">Period</label><select id="rg" name="range" className="input" style={{ width: 'auto' }} defaultValue={range ?? report.query.date.range}>{RANGES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select><button className="btn">Apply</button></form>}
        {body ?? <Card title="Choose a report"><p className="muted">Pick a report on the left. For a custom view, build a <Link href="/dashboards/new">dashboard</Link>.</p></Card>}</div></div></div>;
}
