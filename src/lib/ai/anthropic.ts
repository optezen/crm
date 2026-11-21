import { AiProviderError, type CompleteRequest, type CompleteResponse, type ModelProvider, type StreamEvent } from './provider.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null }>;

/** Anthropic Messages API adapter (tool use). Written to the documented API; exercised with mocked HTTP in tests. */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  constructor(apiKey: string, model?: string, fetchImpl?: FetchLike) { this.apiKey = apiKey; this.model = model || DEFAULT_MODEL; this.fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike); }
  private signalFor(req: CompleteRequest & { signal?: AbortSignal }) { const t = AbortSignal.timeout(req.timeoutMs ?? 45_000); return req.signal ? AbortSignal.any([t, req.signal]) : t; }
  private fail(e: unknown, req: { signal?: AbortSignal }): never {
    if (req.signal?.aborted) throw new AiProviderError('The request was cancelled.', 'cancelled');
    const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    throw new AiProviderError(timeout ? 'The AI service took too long to respond.' : 'The AI service could not be reached.', timeout ? 'timeout' : 'unreachable'); // the key is never part of an error message
  }
  private httpError(status: number): never {
    const kind = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : status >= 500 || status === 529 ? 'overloaded' : 'http';
    throw new AiProviderError(kind === 'auth' ? 'The AI service rejected the configured API key.' : kind === 'rate_limit' ? 'The AI service is rate limiting requests.' : 'The AI service returned an error.', kind, status);
  }
  private body(req: CompleteRequest, stream: boolean) {
    return JSON.stringify({ model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), ...(stream ? { stream: true } : {}),
      ...(req.toolChoice ? { tool_choice: { type: 'tool', name: req.toolChoice.name } } : {}) });
  }
  /** Streaming variant (server-sent events). Text deltas go to `onEvent`; tool-use input is assembled silently; thinking blocks are dropped. */
  async stream(req: CompleteRequest & { signal?: AbortSignal }, onEvent: (e: StreamEvent) => void): Promise<CompleteResponse> {
    let res;
    try { res = await this.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: this.signalFor(req), headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body: this.body(req, true) }); }
    catch (e) { this.fail(e, req); }
    if (!res.ok) this.httpError(res.status);
    if (!res.body) throw new AiProviderError('The AI response could not be read.', 'parse');
    const blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string } | { type: 'skip' })[] = []; let stop = '', inTok = 0, outTok = 0, buf = '';
    const dec = new TextDecoder();
    const handle = (raw: string) => {
      let ev: { type?: string; index?: number; content_block?: { type: string; id?: string; name?: string; text?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; message?: { usage?: { input_tokens?: number; output_tokens?: number } }; usage?: { output_tokens?: number; input_tokens?: number }; error?: unknown };
      try { ev = JSON.parse(raw); } catch { throw new AiProviderError('The AI response could not be read.', 'parse'); }
      switch (ev.type) {
        case 'message_start': inTok = Number(ev.message?.usage?.input_tokens ?? 0) || 0; outTok = Number(ev.message?.usage?.output_tokens ?? 0) || 0; break;
        case 'content_block_start': { const b = ev.content_block; blocks[ev.index ?? blocks.length] = b?.type === 'text' ? { type: 'text', text: b.text ?? '' } : b?.type === 'tool_use' ? { type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), json: '' } : { type: 'skip' }; if (b?.type === 'text' && b.text) onEvent({ type: 'text', text: b.text }); break; }
        case 'content_block_delta': { const b = blocks[ev.index ?? -1]; if (!b) break; if (b.type === 'text' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') { b.text += ev.delta.text; onEvent({ type: 'text', text: ev.delta.text }); } else if (b.type === 'tool_use' && ev.delta?.type === 'input_json_delta') b.json += ev.delta.partial_json ?? ''; break; }
        case 'message_delta': stop = String(ev.delta?.stop_reason ?? stop); outTok = Number(ev.usage?.output_tokens ?? outTok) || outTok; if (ev.usage?.input_tokens) inTok = Number(ev.usage.input_tokens) || inTok; break;
        case 'error': throw new AiProviderError('The AI service reported an error.', 'overloaded');
      }
    };
    try {
      const it = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ? (res.body as AsyncIterable<Uint8Array>) : (async function* (r: ReadableStream<Uint8Array>) { const rd = r.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) return; yield value; } })(res.body as ReadableStream<Uint8Array>);
      for await (const chunk of it) { buf += dec.decode(chunk, { stream: true }); let i: number; while ((i = buf.indexOf('\n\n')) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''); if (data) handle(data); } }
    } catch (e) { if (e instanceof AiProviderError) throw e; this.fail(e, req); }
    const content: CompleteResponse['content'] = [];
    for (const b of blocks) { if (!b) continue; if (b.type === 'text') { if (b.text) content.push({ type: 'text', text: b.text }); } else if (b.type === 'tool_use') { let input: unknown = {}; try { input = b.json ? JSON.parse(b.json) : {}; } catch { throw new AiProviderError('The AI response could not be read.', 'parse'); } content.push({ type: 'tool_use', id: b.id, name: b.name, input }); } }
    if (!stop) throw new AiProviderError('The AI response was interrupted.', 'unreachable'); // the connection ended before the model finished
    return { content, stopReason: stop, usage: { inputTokens: inTok, outputTokens: outTok } };
  }
  async complete(req: CompleteRequest & { signal?: AbortSignal }): Promise<CompleteResponse> {
    let res;
    try {
      res = await this.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: this.signalFor(req),
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: this.body(req, false),
      });
    } catch (e) { this.fail(e, req); }
    if (!res.ok) this.httpError(res.status);
    let body: { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    try { body = (await res.json()) as typeof body; } catch { throw new AiProviderError('The AI response could not be read.', 'parse'); }
    if (!Array.isArray(body?.content)) throw new AiProviderError('The AI response had no content.', 'invalid_output');
    const content: CompleteResponse['content'] = [];
    for (const b of body.content) {
      if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
    }
    return { content, stopReason: String(body.stop_reason ?? ''), usage: { inputTokens: Number(body.usage?.input_tokens ?? 0) || 0, outputTokens: Number(body.usage?.output_tokens ?? 0) || 0 } };
  }
}

/** Picks the configured provider. Returns null when none is configured; callers must then say AI is unavailable (never fake an answer). */
export function providerFor(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): ModelProvider | null {
  const which = (env.OPTIZEN_AI_PROVIDER || 'anthropic').toLowerCase();
  if (which === 'anthropic' && env.ANTHROPIC_API_KEY) return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.OPTIZEN_AI_MODEL, fetchImpl);
  return null;
}
export const aiAvailable = (env: Record<string, string | undefined> = process.env) => providerFor(env) !== null;
