// Request handling for the invoice PDF download, with its collaborators injected so every authorization outcome can be tested without a server.
// Order matters: authenticate first (so nothing about invoice ids is revealed to anonymous callers), then validate the id, then let the DATABASE decide
// (role, billing permission, organization, issued status, visibility scope) and audit the download. Cross-organization ids and missing invoices are indistinguishable (404).
import { invoicePdf, type Snapshot } from './pdf.ts';

export type PdfDeps = {
  organization: () => Promise<{ organizationId: string } | null>;
  rpc: (org: string, id: string) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
};
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const fail = (status: number, error: string) => new Response(JSON.stringify({ ok: false, error }), { status, headers: JSON_HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleInvoicePdf(deps: PdfDeps, id: string): Promise<Response> {
  const who = await deps.organization(); if (!who) return fail(401, 'Please sign in again.');
  if (!UUID.test(id)) return fail(404, 'Invoice not found.');
  const { data, error } = await deps.rpc(who.organizationId, id);
  if (error) return error.code === '42501' ? fail(403, 'You do not have permission to download invoices.') : error.code === 'P0002' ? fail(404, 'Invoice not found.') : fail(500, 'The PDF could not be created.');
  const r = data as { number: string; snapshot: Snapshot } | null; if (!r?.snapshot) return fail(404, 'Invoice not found.');
  let bytes: Buffer; try { bytes = await invoicePdf(r.snapshot); } catch { return fail(500, 'The PDF could not be created.'); }
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="invoice-${String(r.number).replace(/[^A-Za-z0-9-]/g, '')}.pdf"` } });
}
