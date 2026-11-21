import { getAiContext } from '../../../../lib/ai/context';
import { providerFor } from '../../../../lib/ai/anthropic';
import { runTurn, type TurnEvent } from '../../../../lib/ai/chat';
import { loadCards } from '../../../../lib/ai/cards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-sent events for one assistant turn. Events carry only: progress labels, answer text, ids of proposals/plans, a final summary or a curated error. Closing the connection cancels the turn. */
export async function POST(req: Request) {
  const origin = req.headers.get('origin'), host = req.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) return json(403, { ok: false, error: { code: 'forbidden', message: 'Cross-site requests are not allowed.' } });
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { ok: false, error: { code: 'invalid_message', message: 'Send JSON.' } });
  let body: { conversationId?: unknown; message?: unknown; requestId?: unknown };
  try { body = await req.json(); } catch { return json(400, { ok: false, error: { code: 'invalid_message', message: 'Invalid request.' } }); }
  if (body.conversationId != null && (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId))) return json(400, { ok: false, error: { code: 'invalid_message', message: 'Invalid conversation.' } });
  if (body.requestId != null && (typeof body.requestId !== 'string' || !UUID.test(body.requestId))) return json(400, { ok: false, error: { code: 'invalid_message', message: 'Invalid request id.' } });
  const c = await getAiContext(); if (!c) return json(401, { ok: false, error: { code: 'forbidden', message: 'Please sign in again.' } });

  const enc = new TextEncoder(); const abort = new AbortController(); req.signal.addEventListener('abort', () => abort.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let closed = false; const send = (e: unknown) => { if (!closed) try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { closed = true; } };
      const ping = setInterval(() => { if (!closed) try { ctrl.enqueue(enc.encode(': ping\n\n')); } catch { closed = true; } }, 10_000);
      try {
        const r = await runTurn({ provider: providerFor(), ctx: c.ctx, businessName: c.businessName, signal: abort.signal, requestId: (body.requestId as string | null | undefined) ?? null, emit: (e: TurnEvent) => send(e) },
          { conversationId: (body.conversationId as string | null | undefined) ?? null, message: body.message });
        if (r.ok) { const cards = await loadCards(c, r.proposalIds, r.planIds); send({ type: 'done', conversationId: r.conversationId, text: r.text, replayed: !!r.replayed, ...cards }); }
        else send({ type: 'error', code: r.error.code, message: r.error.message, conversationId: r.conversationId });
      } catch { send({ type: 'error', code: 'unavailable', message: 'The assistant could not complete this request. Please try again.' }); }
      finally { clearInterval(ping); closed = true; try { ctrl.close(); } catch { /* already closed */ } }
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' } });
}
