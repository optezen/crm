import { getWorkspaceState } from '../../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../../lib/supabase/server';
import { invoicePdf, type Snapshot } from '../../../../../../lib/billing/pdf';

export const dynamic = 'force-dynamic';
const fail = (status: number, error: string) => new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** PDF of an ISSUED invoice, rendered only from its immutable snapshot. Access (manager+, billing view permission, own organization) is checked and audited in the database. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(404, 'Invoice not found.');
  const s = await getWorkspaceState(); if (s.status !== 'ready') return fail(401, 'Please sign in again.');
  const { data, error } = await (await supabaseServer()).rpc('invoice_pdf_access', { p_org: s.organizationId, p_id: id });
  if (error) return fail(error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 500, error.code === '42501' || error.code === 'P0002' ? error.message : 'The PDF could not be created.');
  const r = data as { number: string; snapshot: Snapshot }; const bytes = invoicePdf(r.snapshot);
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="invoice-${r.number.replace(/[^A-Za-z0-9-]/g, '')}.pdf"` } });
}
