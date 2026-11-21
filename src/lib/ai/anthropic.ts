import { AiProviderError, type CompleteRequest, type CompleteResponse, type ModelProvider } from './provider.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Anthropic Messages API adapter (tool use). Written to the documented API; exercised with mocked HTTP in tests. */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  constructor(apiKey: string, model?: string, fetchImpl?: FetchLike) { this.apiKey = apiKey; this.model = model || DEFAULT_MODEL; this.fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike); }
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    let res;
    try {
      res = await this.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(req.timeoutMs ?? 45_000),
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          ...(req.toolChoice ? { tool_choice: { type: 'tool', name: req.toolChoice.name } } : {}) }),
      });
    } catch (e) {
      const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      throw new AiProviderError(timeout ? 'The AI service took too long to respond.' : 'The AI service could not be reached.', timeout ? 'timeout' : 'unreachable'); // the key is never part of an error message
    }
    if (!res.ok) {
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 || res.status === 529 ? 'overloaded' : 'http';
      throw new AiProviderError(kind === 'auth' ? 'The AI service rejected the configured API key.' : kind === 'rate_limit' ? 'The AI service is rate limiting requests.' : 'The AI service returned an error.', kind, res.status);
    }
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
