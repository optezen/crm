// Web-side handling of provider webhooks (Vercel route handlers call these). The signature is verified on the RAW body with the platform app secret,
// then normalized events go to the database through the gateway credential. The service-role key is never needed here.
import { verifyMetaSignature } from './signature.ts';
import { verifyChallenge, parseLeadgenWebhook, type GatewayEvent } from './meta.ts';
import { parseWhatsAppWebhook } from './whatsapp.ts';

export type ReceiveRpc = (args: { p_provider: string; p_gateway_secret: string; p_events: GatewayEvent[] }) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
export type WebhookEnv = { META_APP_SECRET?: string; META_WEBHOOK_VERIFY_TOKEN?: string; INTEGRATION_GATEWAY_SECRET?: string };
const res = (status: number, body: string, type = 'text/plain') => new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } });

export async function handleProviderWebhook(req: Request, provider: 'meta_lead_ads' | 'whatsapp', env: WebhookEnv, rpc: ReceiveRpc): Promise<Response> {
  if (req.method === 'GET') {
    const c = verifyChallenge(new URL(req.url).searchParams, env.META_WEBHOOK_VERIFY_TOKEN);
    return c === null ? res(403, 'Verification failed') : res(200, c);
  }
  if (req.method !== 'POST') return res(405, 'Method not allowed');
  if (!env.META_APP_SECRET || !env.INTEGRATION_GATEWAY_SECRET) return res(503, 'Not configured'); // never accept unsigned traffic because setup is incomplete
  const raw = await req.text();
  if (raw.length > 500_000) return res(413, 'Too large');
  if (!verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), env.META_APP_SECRET)) return res(401, 'Invalid signature');
  let body: unknown; try { body = JSON.parse(raw); } catch { return res(400, 'Invalid JSON'); }
  const events = provider === 'meta_lead_ads' ? parseLeadgenWebhook(body) : parseWhatsAppWebhook(body);
  if (events.length === 0) return res(200, 'ok'); // valid but nothing we act on (e.g. inbound chat messages)
  const { data, error } = await rpc({ p_provider: provider, p_gateway_secret: env.INTEGRATION_GATEWAY_SECRET, p_events: events.slice(0, 200) });
  if (error || (data as { status?: string })?.status !== 'ok') return res(503, 'Retry later'); // non-2xx makes Meta retry the delivery
  return res(200, 'ok');
}
