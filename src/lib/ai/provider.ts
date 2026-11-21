// Model-provider abstraction. The assistant talks to a `ModelProvider`, never to a vendor SDK, so another provider can be added by implementing
// one interface and registering it in `providerFor`. One provider (Anthropic) is implemented today; the key stays server-side.
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ChatMessage = { role: 'user' | 'assistant'; content: string | (TextBlock | ToolUseBlock | ToolResultBlock)[] };
export type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };
export type CompleteRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number; toolChoice?: { name: string }; timeoutMs?: number };
export type CompleteResponse = { content: (TextBlock | ToolUseBlock)[]; stopReason: string; usage: { inputTokens: number; outputTokens: number } };
export interface ModelProvider { readonly id: string; readonly model: string; complete(req: CompleteRequest): Promise<CompleteResponse> }

/** `unreachable`: network/timeout. `http`: non-2xx. `parse`: unreadable body. `auth`: bad key. `rate_limit`. `overloaded`: 5xx/529. */
export type AiErrorKind = 'unreachable' | 'timeout' | 'http' | 'parse' | 'auth' | 'rate_limit' | 'overloaded' | 'invalid_output';
export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  constructor(message: string, kind: AiErrorKind, status?: number) { super(message); this.name = 'AiProviderError'; this.kind = kind; this.status = status; }
  get retryable() { return this.kind === 'unreachable' || this.kind === 'timeout' || this.kind === 'overloaded'; }
}
