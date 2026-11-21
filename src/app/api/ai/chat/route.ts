import { getAiContext } from '../../../../lib/ai/context';
import { providerFor } from '../../../../lib/ai/anthropic';
import { runTurn } from '../../../../lib/ai/chat';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  // cookie-authenticated endpoint: only same-origin JSON requests are accepted (CSRF)
  const origin = req.headers.get('origin'), host = req.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) return json(403, { ok: false, error: { code: 'forbidden', message: 'Cross-site requests are not allowed.' } });
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { ok: false, error: { code: 'invalid_message', message: 'Send JSON.' } });
  let body: { conversationId?: unknown; message?: unknown };
  try { body = await req.json(); } catch { return json(400, { ok: false, error: { code: 'invalid_message', message: 'Invalid request.' } }); }
  if (body.conversationId !== undefined && body.conversationId !== null && (typeof body.conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.conversationId))) return json(400, { ok: false, error: { code: 'invalid_message', message: 'Invalid conversation.' } });
  const c = await getAiContext();
  if (!c) return json(401, { ok: false, error: { code: 'forbidden', message: 'Please sign in again.' } });
  const r = await runTurn({ provider: providerFor(), ctx: c.ctx, businessName: c.businessName }, { conversationId: (body.conversationId as string | null | undefined) ?? null, message: body.message });
  if (!r.ok) return json(r.error.code === 'not_found' ? 404 : r.error.code === 'budget' || r.error.code === 'busy' ? 429 : r.error.code === 'not_configured' ? 503 : r.error.code === 'invalid_message' ? 400 : 502, r);
  const { data } = r.proposalIds.length ? await c.db.from('ai_proposals').select('id, kind, title, payload, status, workflow_id').in('id', r.proposalIds) : { data: [] };
  return json(200, { ok: true, conversationId: r.conversationId, text: r.text, proposals: data ?? [], toolCalls: r.toolCalls });
}
