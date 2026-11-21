import { getWorkspaceState } from '../../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../../lib/supabase/server';
import { handleInvoicePdf } from '../../../../../../lib/billing/pdfRoute';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PDF of an ISSUED invoice, rendered only from its immutable snapshot. Authorization and auditing happen in the database (invoice_pdf_access). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleInvoicePdf({
    organization: async () => { const s = await getWorkspaceState(); return s.status === 'ready' ? { organizationId: s.organizationId } : null; },
    rpc: async (org, inv) => (await supabaseServer()).rpc('invoice_pdf_access', { p_org: org, p_id: inv }),
  }, id);
}
