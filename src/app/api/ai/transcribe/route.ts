import { getAiContext } from '../../../../lib/ai/context';
import { speechProviderFor, MAX_AUDIO_BYTES } from '../../../../lib/ai/speech';
import { transcribeRequest } from '../../../../lib/ai/transcribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 45;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Voice input: audio in, transcript text out. The audio is held in memory only for this request: it is not saved, logged or reused. The user reviews and edits the text before anything is sent to the assistant. */
export async function POST(req: Request) {
  const origin = req.headers.get('origin'), host = req.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) return json(403, { ok: false, code: 'forbidden', message: 'Cross-site requests are not allowed.' });
  const len = Number(req.headers.get('content-length') ?? 0); if (len > MAX_AUDIO_BYTES + 4096) return json(413, { ok: false, code: 'too_large', message: 'That recording is too large. Keep it under two minutes.' });
  if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return json(415, { ok: false, code: 'unsupported', message: 'Send the recording as form data.' });
  const c = await getAiContext(); if (!c) return json(401, { ok: false, code: 'forbidden', message: 'Please sign in again.' });
  let form: FormData; try { form = await req.formData(); } catch { return json(400, { ok: false, code: 'invalid_audio', message: 'The recording could not be read.' }); }
  const file = form.get('audio'); if (!(file instanceof Blob)) return json(400, { ok: false, code: 'invalid_audio', message: 'No recording was sent.' });
  const r = await transcribeRequest({ provider: speechProviderFor(), org: c.ctx.org, rpc: c.ctx.rpc, signal: req.signal }, { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, seconds: Number(form.get('seconds') ?? 0) });
  return r.ok ? json(200, { ok: true, text: r.text }) : json(r.status, { ok: false, code: r.code, message: r.message });
}
