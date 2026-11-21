// One voice request: authorize, reserve capacity, validate the audio, transcribe in memory, settle usage. Dependencies are injected so every outcome is testable.
import { AUDIO_TYPES, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, SpeechError, baseMime, audioExt, looksLikeAudio, type SpeechProvider } from './speech.ts';
import type { Rpc } from './tools.ts';

export type VoiceResult = { ok: true; text: string } | { ok: false; status: number; code: string; message: string };
const no = (status: number, code: string, message: string): VoiceResult => ({ ok: false, status, code, message });
export async function transcribeRequest(d: { provider: SpeechProvider | null; org: string; rpc: Rpc; signal?: AbortSignal }, input: { bytes: Uint8Array; mime: string; seconds: number }): Promise<VoiceResult> {
  if (!d.provider) return no(503, 'not_configured', 'Voice input is not configured on this deployment. You can type your message instead.');
  const mime = baseMime(input.mime);
  if (!(AUDIO_TYPES as readonly string[]).includes(mime)) return no(415, 'unsupported', 'That audio format is not supported. Type your message instead.');
  if (input.bytes.length > MAX_AUDIO_BYTES) return no(413, 'too_large', 'That recording is too large. Keep it under two minutes.');
  if (!looksLikeAudio(input.bytes)) return no(400, 'invalid_audio', 'That does not look like an audio recording.');
  const seconds = Math.min(Math.max(Math.round(Number(input.seconds) || 0), 0), MAX_AUDIO_SECONDS);
  const res = (await d.rpc('ai_reserve', { p_org: d.org, p_request: null, p_est: 0, p_kind: 'transcription' })).data as { allowed?: boolean; reason?: string; usage_id?: string } | null;
  if (!res?.allowed || !res.usage_id) return no(429, 'budget', res?.reason ?? 'Voice input is not available right now.');
  const started = Date.now(); let status: 'ok' | 'error' | 'cancelled' = 'error'; let detail: string | null = null;
  try {
    const r = await d.provider.transcribe({ bytes: input.bytes, mime, filename: `speech.${audioExt(mime)}` }, { signal: d.signal });
    status = 'ok'; return { ok: true, text: r.text };
  } catch (e) {
    if (e instanceof SpeechError) { detail = e.kind; status = e.kind === 'cancelled' ? 'cancelled' : 'error';
      return e.kind === 'cancelled' ? no(499, 'cancelled', 'Cancelled.') : e.kind === 'empty' ? no(422, 'empty', 'No speech was recognised. Try again, or type your message.') : e.kind === 'auth' ? no(502, 'provider_auth', 'Voice input is not configured correctly. Ask an administrator.')
        : e.kind === 'rate_limit' ? no(429, 'busy', 'The transcription service is busy. Try again in a minute.') : e.kind === 'timeout' ? no(504, 'timeout', 'Transcription took too long. Try a shorter recording, or type your message.') : e.kind === 'too_large' ? no(413, 'too_large', 'That recording is too large.') : no(502, 'unavailable', 'Voice input is unavailable right now. You can type your message instead.'); }
    detail = 'error'; return no(502, 'unavailable', 'Voice input is unavailable right now. You can type your message instead.');
  } finally { await d.rpc('ai_settle', { p_org: d.org, p_usage: res.usage_id, p_provider: d.provider.id, p_model: d.provider.model, p_in: 0, p_out: 0, p_tools: 0, p_status: status, p_error: detail, p_ms: Date.now() - started, p_audio: seconds }); }
}
