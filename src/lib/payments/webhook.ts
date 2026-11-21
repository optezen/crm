// Web-side handling of a payment-gateway webhook. Order: find the connection (gateway credential only; no service key) -> decrypt its webhook secret ->
// verify the signature on the RAW body -> normalize -> hand events to the database. Responses: 200 stored (including duplicates), 401 bad signature,
// 404 unknown connection, 503 not configured or database trouble (non-2xx makes the gateway retry; stored duplicates are ignored).
import { decryptJson, type Key } from '../integrations/crypto.ts';
import { gatewayAdapter } from './gateway.ts';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
export type PaymentWebhookEnv = { INTEGRATION_GATEWAY_SECRET?: string; key: Key | null };
const res = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
export async function handlePaymentWebhook(req: Request, publicId: string, env: PaymentWebhookEnv, rpc: Rpc): Promise<Response> {
  if (req.method !== 'POST') return res(405, 'Method not allowed');
  if (!env.INTEGRATION_GATEWAY_SECRET || !env.key) return res(503, 'Not configured');
  const raw = await req.text(); if (raw.length > 200_000) return res(413, 'Too large');
  const c = await rpc('payment_gateway_connection', { p_public_id: publicId, p_gateway_secret: env.INTEGRATION_GATEWAY_SECRET });
  const info = c.data as { status?: string; connection_id?: string; gateway?: string; ciphertext?: string } | null;
  if (c.error || !info) return res(503, 'Retry later'); if (info.status === 'unknown') return res(404, 'Unknown'); if (info.status !== 'ok') return res(503, 'Retry later');
  const adapter = gatewayAdapter(info.gateway ?? ''); if (!adapter) return res(503, 'Unsupported gateway');
  let secret: string; try { secret = decryptJson<{ webhook_secret: string }>(info.ciphertext!, env.key).webhook_secret; } catch { return res(503, 'Retry later'); }
  if (!adapter.verify(raw, req.headers, secret)) return res(401, 'Invalid signature');
  let body: unknown; try { body = JSON.parse(raw); } catch { return res(400, 'Invalid JSON'); }
  const events = adapter.parse(body, req.headers); if (events.length === 0) return res(200, 'ok'); // verified, but nothing we record (other events, unreadable amounts)
  const r = await rpc('payment_gateway_receive', { p_conn: info.connection_id, p_gateway_secret: env.INTEGRATION_GATEWAY_SECRET, p_events: events.map(e => ({ event_id: e.eventId, kind: e.kind, provider_payment_id: e.providerPaymentId, invoice_id: e.invoiceId, amount: e.amount, currency: e.currency, method: e.method })) });
  return r.error || (r.data as { status?: string })?.status !== 'ok' ? res(503, 'Retry later') : res(200, 'ok');
}
