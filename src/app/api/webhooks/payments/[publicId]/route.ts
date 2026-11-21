import { handlePaymentWebhook } from '../../../../../lib/payments/webhook';
import { anonClient, supabaseReady } from '../../../../../lib/integrations/anon';
import { keyringFromEnv, type Key } from '../../../../../lib/integrations/crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Payment gateway webhook for ONE connection (the id in the URL only selects the connection; trust comes from the signature check with that connection's secret). */
export async function POST(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!supabaseReady()) return new Response('Not configured', { status: 503 });
  let key: Key | null = null; try { key = keyringFromEnv(process.env); } catch { key = null; }
  const db = anonClient(); const { publicId } = await params;
  return handlePaymentWebhook(req, publicId, { INTEGRATION_GATEWAY_SECRET: process.env.INTEGRATION_GATEWAY_SECRET, key }, (fn, args) => db.rpc(fn, args));
}
export async function GET() { return new Response('Method not allowed', { status: 405 }); }
