import { getCrmContext } from '../../../../../lib/crm/context';
import { isManager, listLeads } from '../../../../../lib/crm/service';
import { parseListParams } from '../../../../../lib/crm/validate';
import { SOURCE_LABEL } from '../../../../../lib/crm/types';

const cell = (v: string | number | null) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** CSV of the leads matching the list's filters. Managers only; capped at 2,000 rows; contact details hidden by role stay hidden. */
export async function GET(req: Request) {
  const c = await getCrmContext(); if (!c) return new Response('Sign in first.', { status: 401 });
  if (!isManager(c.role)) return new Response('Only managers can export leads.', { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams); const base = parseListParams(sp, c.stages);
  const lines = ['Name,Phone,Email,Source,Stage,Notes,Created'];
  for (let page = 1; page <= 80; page++) {
    const r = await listLeads(c, { ...base, page }); if (!r.ok) return new Response(r.error, { status: 500 });
    for (const l of r.value.rows) lines.push([l.fullName, l.contactHidden ? '' : l.phone, l.contactHidden ? '' : l.email, SOURCE_LABEL[l.source], l.stage, l.summary, l.createdAt.slice(0, 10)].map(cell).join(','));
    if (page >= r.value.pageCount) break;
  }
  return new Response('﻿' + lines.join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"', 'cache-control': 'no-store' } });
}
