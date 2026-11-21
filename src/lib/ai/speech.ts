// Speech-to-text provider abstraction. The assistant's voice input talks to a `SpeechProvider`, never to a vendor API, so another engine can be added by implementing one
// interface and registering it in `speechProviderFor`. One provider is implemented: OpenAI-compatible audio transcription (the key stays server-side).
// Raw audio is processed in memory and forwarded to the provider; Optizen never writes it to disk, a database or a log. Only the transcript text is returned to the user.
export type AudioInput = { bytes: Uint8Array; mime: string; filename: string };
export type TranscribeOptions = { language?: string; signal?: AbortSignal; timeoutMs?: number };
export interface SpeechProvider { readonly id: string; readonly model: string; transcribe(audio: AudioInput, opts?: TranscribeOptions): Promise<{ text: string }> }

export type SpeechErrorKind = 'cancelled' | 'unreachable' | 'timeout' | 'auth' | 'rate_limit' | 'http' | 'parse' | 'too_large' | 'unsupported' | 'empty';
export class SpeechError extends Error {
  readonly kind: SpeechErrorKind;
  constructor(message: string, kind: SpeechErrorKind) { super(message); this.name = 'SpeechError'; this.kind = kind; }
}
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024, MAX_AUDIO_SECONDS = 120, MIN_AUDIO_BYTES = 400;
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/x-m4a', 'audio/m4a'] as const;
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a' };
export const baseMime = (m: string) => m.split(';')[0]!.trim().toLowerCase();
export const audioExt = (m: string) => EXT[baseMime(m)] ?? 'webm';

/** Cheap content sniffing so a renamed file is not forwarded as audio: containers start with EBML (webm), OggS, RIFF/WAVE, ID3/MPEG frame sync or an MP4 'ftyp' box. */
export function looksLikeAudio(b: Uint8Array): boolean {
  if (b.length < MIN_AUDIO_BYTES) return false; const s = (o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
  return (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || s(0, 4) === 'OggS' || (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') || s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) || s(4, 4) === 'ftyp';
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export class OpenAiTranscriber implements SpeechProvider {
  readonly id = 'openai'; readonly model: string; private readonly key: string; private readonly base: string; private readonly fetch: FetchLike;
  constructor(apiKey: string, model?: string, fetchImpl?: FetchLike, baseUrl?: string) { this.key = apiKey; this.model = model || 'whisper-1'; this.base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''); this.fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike); }
  async transcribe(audio: AudioInput, opts: TranscribeOptions = {}): Promise<{ text: string }> {
    if (audio.bytes.length > MAX_AUDIO_BYTES) throw new SpeechError('That recording is too large.', 'too_large');
    const form = new FormData(); form.append('model', this.model); form.append('response_format', 'json'); if (opts.language) form.append('language', opts.language);
    form.append('file', new Blob([audio.bytes as BlobPart], { type: baseMime(audio.mime) }), audio.filename);
    const t = AbortSignal.timeout(opts.timeoutMs ?? 30_000); const signal = opts.signal ? AbortSignal.any([t, opts.signal]) : t;
    let res;
    try { res = await this.fetch(`${this.base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${this.key}` }, body: form, signal }); }
    catch (e) { if (opts.signal?.aborted) throw new SpeechError('Cancelled.', 'cancelled'); const to = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError'; throw new SpeechError(to ? 'Transcription took too long.' : 'The transcription service could not be reached.', to ? 'timeout' : 'unreachable'); }
    if (!res.ok) throw new SpeechError(res.status === 401 || res.status === 403 ? 'The transcription service rejected the configured key.' : res.status === 429 ? 'The transcription service is busy.' : res.status === 413 ? 'That recording is too large.' : 'The transcription service returned an error.', res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status === 413 ? 'too_large' : 'http');
    let body: { text?: unknown }; try { body = (await res.json()) as typeof body; } catch { throw new SpeechError('The transcript could not be read.', 'parse'); }
    const text = typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : '';
    if (!text) throw new SpeechError('No speech was recognised.', 'empty');
    return { text: text.slice(0, 4000) };
  }
}
/** The configured provider, or null (callers must then say voice is unavailable and offer typing). */
export function speechProviderFor(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): SpeechProvider | null {
  const which = (env.OPTIZEN_SPEECH_PROVIDER || 'openai').toLowerCase(); const key = env.OPTIZEN_SPEECH_API_KEY || env.OPENAI_API_KEY;
  if (which === 'openai' && key) return new OpenAiTranscriber(key, env.OPTIZEN_SPEECH_MODEL, fetchImpl, env.OPTIZEN_SPEECH_BASE_URL);
  return null;
}
export const speechAvailable = (env: Record<string, string | undefined> = process.env) => speechProviderFor(env) !== null;
