import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { REPORTS } from '../../../../lib/analytics/reports';
import { RANGES, type Query, type QueryResult } from '../../../../lib/analytics/types';
import { toCsv } from '../../../../lib/analytics/csv';

export const dynamic = 'force-dynamic';
const fail = (status: number, error: string) => new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Authorized CSV export. Only predefined reports or a dashboard widget the caller can read can be exported (never an arbitrary query from the URL). Needs the module's `export` permission; the database enforces it and the export is audited. */
export async function GET(req: Request) {
  const url = new URL(req.url); const s = await getWorkspaceState(); if (s.status !== 'ready') return fail(401, 'Please sign in again.');
  const db = await supabaseServer(); const tz = s.config.operations?.appointments?.timezone ?? 'UTC'; let query: Query | null = null, name = 'report';
  const rk = url.searchParams.get('r'), wid = url.searchParams.get('widget'), range = RANGES.find(x => x.value === url.searchParams.get('range'))?.value;
  if (rk) { const r = REPORTS.find(x => x.key === rk); if (!r) return fail(404, 'Unknown report.'); query = { ...structuredClone(r.query), tz, ...(r.query.date && range ? { date: { ...r.query.date, range } } : {}) }; name = r.key; }
  else if (wid && /^[0-9a-f-]{36}$/i.test(wid)) { const { data } = await db.from('dashboard_widgets').select('query, title').eq('id', wid).maybeSingle(); if (!data) return fail(404, 'Widget not found.'); query = { ...(data.query as Query), tz: (data.query as Query).tz ?? tz }; name = 'widget'; }
  if (!query) return fail(400, 'Choose a report.');
  const { data, error } = await db.rpc('analytics_export', { p_org: s.organizationId, p_q: query });
  if (error) return fail(error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500, error.code === '42501' || error.code === '22023' ? error.message : 'The export failed.');
  const res = data as QueryResult;
  await db.rpc('analytics_export_log', { p_org: s.organizationId, p_source: query.source, p_rows: res.row_count, p_definition: res.definition });
  return new Response(toCsv(res), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="optizen-${name}-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
