import { timingSafeEqual } from 'node:crypto';
import { handleWorkerHealth } from '../../../../lib/ops/worker-health';
import { anonClient, supabaseReady } from '../../../../lib/integrations/anon';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** For uptime monitors: GET with "Authorization: Bearer <OPS_HEALTH_TOKEN>". 200 = all workers reporting; 503 = a worker is stale or missing (alert). */
export async function GET(req: Request) {
  if (!supabaseReady()) return new Response(JSON.stringify({ ok: false, error: 'Not configured' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const db = anonClient();
  return handleWorkerHealth(req, { OPS_HEALTH_TOKEN: process.env.OPS_HEALTH_TOKEN, INTEGRATION_GATEWAY_SECRET: process.env.INTEGRATION_GATEWAY_SECRET }, (fn, args) => db.rpc(fn, args), timingSafeEqual);
}
