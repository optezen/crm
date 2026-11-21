import { handleFormSubmission } from '../../../../../lib/integrations/forms';
import { anonClient, supabaseReady } from '../../../../../lib/integrations/anon';

export const dynamic = 'force-dynamic';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Server-to-server only: the credential must never be embedded in browser JavaScript, so no CORS headers are sent.
export async function POST(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!supabaseReady()) return json(503, { ok: false, error: 'Optizen is not configured.' });
  const { publicId } = await params;
  const db = anonClient();
  return handleFormSubmission(req, publicId, args => db.rpc('integration_ingest_form', args));
}
export async function GET() { return json(405, { ok: false, error: 'Send a POST request. See the setup instructions on the Connections page.' }); }
