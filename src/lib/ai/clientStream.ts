// Client side of the assistant stream: a tolerant server-sent-events parser and a pure reducer from events to UI state. Kept free of React so it is testable.
export type Card = { proposals: unknown[]; plans: unknown[] };
export type ToolState = { name: string; label: string; state: 'running' | 'done' | 'failed' };
export type UiTurn = { text: string; tools: ToolState[]; conversationId: string | null; done: boolean; replayed: boolean; cards: Card; error: { code: string; message: string } | null };
export const emptyTurn = (): UiTurn => ({ text: '', tools: [], conversationId: null, done: false, replayed: false, cards: { proposals: [], plans: [] }, error: null });

/** Splits a byte stream into `data:` frames. Comment lines (": ping") and partial frames are handled; frames are returned only when complete. */
export class SseParser {
  private buf = ''; private readonly dec = new TextDecoder();
  push(chunk: Uint8Array | string): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : this.dec.decode(chunk, { stream: true }); const out: unknown[] = []; let i: number;
    while ((i = this.buf.search(/\r?\n\r?\n/)) >= 0) { const m = /\r?\n\r?\n/.exec(this.buf.slice(i))!; const frame = this.buf.slice(0, i); this.buf = this.buf.slice(i + m[0].length);
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (!data) continue; try { out.push(JSON.parse(data)); } catch { /* ignore a malformed frame */ } }
    return out;
  }
}

export function reduce(s: UiTurn, e: Record<string, unknown>): UiTurn {
  switch (e.type) {
    case 'start': return { ...s, conversationId: String(e.conversationId ?? s.conversationId ?? '') || null };
    case 'text': return { ...s, text: s.text + String(e.text ?? '') };
    case 'reset': return { ...s, text: '' };
    case 'tool_start': return { ...s, tools: [...s.tools, { name: String(e.name), label: String(e.label), state: 'running' }] };
    case 'tool_end': { const tools = [...s.tools]; for (let i = tools.length - 1; i >= 0; i--) if (tools[i]!.name === e.name && tools[i]!.state === 'running') { tools[i] = { ...tools[i]!, state: e.ok ? 'done' : 'failed' }; break; } return { ...s, tools }; }
    case 'done': return { ...s, done: true, text: String(e.text ?? s.text), conversationId: String(e.conversationId ?? s.conversationId ?? '') || null, replayed: !!e.replayed, cards: { proposals: (e.proposals as unknown[]) ?? [], plans: (e.plans as unknown[]) ?? [] } };
    case 'error': return { ...s, error: { code: String(e.code ?? 'unavailable'), message: String(e.message ?? 'The assistant could not answer.') }, conversationId: (e.conversationId as string | null) ?? s.conversationId };
    default: return s;
  }
}
/** Reads a whole turn. A connection that closes without `done` or `error` is reported as an interruption (the caller can retry with the same request id, which never repeats work). */
export async function readTurn(res: Response, onState: (s: UiTurn) => void): Promise<UiTurn> {
  let s = emptyTurn(); const p = new SseParser();
  if (!res.body) return { ...s, error: { code: 'interrupted', message: 'The connection was interrupted.' } };
  const rd = res.body.getReader();
  try { for (;;) { const { done, value } = await rd.read(); if (done) break; for (const ev of p.push(value)) { s = reduce(s, ev as Record<string, unknown>); onState(s); } } }
  catch { if (!s.done && !s.error) s = { ...s, error: { code: 'interrupted', message: 'The connection was interrupted.' } }; }
  if (!s.done && !s.error) s = { ...s, error: { code: 'interrupted', message: 'The connection was interrupted before the answer was complete.' } };
  onState(s); return s;
}
