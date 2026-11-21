// One conversation turn: budget check -> persist the user message -> model <-> tool loop (bounded) -> persist the answer -> usage + audit.
// The model can only call the registered tools; it has no access to SQL, code execution or the network. Every limit below is a hard stop.
import { AiProviderError, type ChatMessage, type ModelProvider, type ToolResultBlock } from './provider.ts';
import { executeTool, toolSpecs, type ToolCtx } from './tools.ts';
import { systemPrompt } from './prompt.ts';

export type Limits = { maxSteps: number; maxToolCalls: number; maxOutputTokens: number; maxTokensPerCall: number; turnTimeoutMs: number; toolTimeoutMs: number; historyMessages: number };
export const DEFAULT_LIMITS: Limits = { maxSteps: 6, maxToolCalls: 8, maxOutputTokens: 8000, maxTokensPerCall: 1200, turnTimeoutMs: 55_000, toolTimeoutMs: 8_000, historyMessages: 12 };
export type TurnError = { code: 'not_configured' | 'invalid_message' | 'budget' | 'not_found' | 'busy' | 'unavailable' | 'provider_auth' | 'invalid_output' | 'limit' | 'timeout'; message: string };
export type TurnResult = { ok: true; conversationId: string; text: string; proposalIds: string[]; toolCalls: number } | { ok: false; conversationId: string | null; error: TurnError };

const errorFor = (e: unknown): TurnError => {
  if (e instanceof AiProviderError) {
    if (e.kind === 'auth') return { code: 'provider_auth', message: 'The AI assistant is not configured correctly (its API key was rejected). Ask an administrator.' };
    if (e.kind === 'rate_limit') return { code: 'busy', message: 'The AI service is busy right now. Please try again in a minute.' };
    if (e.kind === 'invalid_output' || e.kind === 'parse') return { code: 'invalid_output', message: 'The AI returned a response Optizen could not use. Please try again or rephrase.' };
    if (e.kind === 'timeout') return { code: 'timeout', message: 'The AI took too long to answer. Please try again.' };
    return { code: 'unavailable', message: 'The AI service is unavailable right now. Your records are unaffected. Please try again later.' };
  }
  return { code: 'unavailable', message: 'The assistant could not complete this request. Please try again.' };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type TurnDeps = { provider: ModelProvider | null; ctx: ToolCtx; businessName: string; limits?: Partial<Limits>; today?: string; retryDelayMs?: number };

export async function runTurn(deps: TurnDeps, input: { conversationId?: string | null; message: unknown }): Promise<TurnResult> {
  const { ctx } = deps; const L = { ...DEFAULT_LIMITS, ...deps.limits }; const started = Date.now();
  const text = typeof input.message === 'string' ? input.message.trim() : '';
  if (!text || text.length > 4000) return { ok: false, conversationId: input.conversationId ?? null, error: { code: 'invalid_message', message: 'Write a message of up to 4000 characters.' } };
  if (!deps.provider) return { ok: false, conversationId: input.conversationId ?? null, error: { code: 'not_configured', message: 'The AI assistant is not configured on this deployment (no model API key). Nothing was sent anywhere.' } };
  const provider = deps.provider;
  const usage = async (status: 'ok' | 'error' | 'blocked', conv: string | null, inTok: number, outTok: number, tools: number, error?: string) =>
    ctx.rpc('ai_record_usage', { p_org: ctx.org, p_conv: conv, p_provider: provider.id, p_model: provider.model, p_in: inTok, p_out: outTok, p_tools: tools, p_status: status, p_error: error ?? null, p_ms: Date.now() - started });

  const budget = (await ctx.rpc('ai_budget', { p_org: ctx.org })).data as { allowed?: boolean; reason?: string } | null;
  if (!budget?.allowed) { await usage('blocked', input.conversationId ?? null, 0, 0, 0, budget?.reason); return { ok: false, conversationId: input.conversationId ?? null, error: { code: 'budget', message: budget?.reason ?? 'AI usage is not available right now.' } }; }

  // conversation + user message (ai_add_message refuses conversations that are not the caller's, in this organization)
  let conv = input.conversationId ?? null;
  if (!conv) { const c = await ctx.rpc('ai_create_conversation', { p_org: ctx.org, p_title: text.slice(0, 80) }); if (c.error) return { ok: false, conversationId: null, error: { code: 'unavailable', message: 'Could not start a conversation.' } }; conv = c.data as string; }
  const added = await ctx.rpc('ai_add_message', { p_org: ctx.org, p_conv: conv, p_role: 'user', p_content: { text } });
  if (added.error) return { ok: false, conversationId: null, error: added.error.code === 'P0002' ? { code: 'not_found', message: 'That conversation was not found.' } : { code: 'unavailable', message: 'Could not save your message.' } };
  const ctxWithConv: ToolCtx = { ...ctx, conversationId: conv };

  const hist = ((await ctx.rpc('ai_recent_messages', { p_org: ctx.org, p_conv: conv, p_limit: L.historyMessages })).data as { role: 'user' | 'assistant'; text: string }[] | null) ?? [];
  const messages: ChatMessage[] = hist.filter(m => m.text).map(m => ({ role: m.role, content: m.text }));
  if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: text });
  // the API requires alternating roles starting with user; merge any accidental repeats
  const norm: ChatMessage[] = []; for (const m of messages) { const last = norm[norm.length - 1]; if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n' + m.content; else norm.push({ ...m }); }
  while (norm[0]?.role === 'assistant') norm.shift();

  const system = systemPrompt({ businessName: deps.businessName, role: ctx.role, today: deps.today ?? new Date().toISOString().slice(0, 10) });
  const tools = toolSpecs(ctx.role);
  let inTok = 0, outTok = 0, calls = 0; const proposalIds: string[] = [];
  const fail = async (e: TurnError, detail?: string): Promise<TurnResult> => { await usage('error', conv, inTok, outTok, calls, detail ?? e.code); return { ok: false, conversationId: conv, error: e }; };

  try {
    for (let step = 0; ; step++) {
      if (step >= L.maxSteps) return await fail({ code: 'limit', message: 'The assistant needed too many steps for this request. Try a narrower question.' });
      if (Date.now() - started > L.turnTimeoutMs) return await fail({ code: 'timeout', message: 'This took too long. Try a narrower question.' });
      let resp;
      for (let attempt = 0; ; attempt++) {
        try { resp = await provider.complete({ system, messages: norm, tools, maxTokens: L.maxTokensPerCall, timeoutMs: Math.max(1000, Math.min(30_000, L.turnTimeoutMs - (Date.now() - started))) }); break; }
        catch (e) { if (attempt === 0 && e instanceof AiProviderError && e.retryable) { await sleep(deps.retryDelayMs ?? 600); continue; } throw e; } // retry once: the call is a pure read, so repeating it is safe
      }
      inTok += resp.usage.inputTokens; outTok += resp.usage.outputTokens;
      if (outTok > L.maxOutputTokens) return await fail({ code: 'limit', message: 'This request used too much AI capacity. Try a narrower question.' });
      const uses = resp.content.filter(b => b.type === 'tool_use');
      const answer = resp.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
      if (uses.length === 0) {
        if (!answer) throw new AiProviderError('Empty answer.', 'invalid_output');
        await ctx.rpc('ai_add_message', { p_org: ctx.org, p_conv: conv, p_role: 'assistant', p_content: { text: answer, proposals: proposalIds } });
        await usage('ok', conv, inTok, outTok, calls);
        return { ok: true, conversationId: conv, text: answer, proposalIds, toolCalls: calls };
      }
      norm.push({ role: 'assistant', content: resp.content });
      const results: ToolResultBlock[] = [];
      for (const u of uses) {
        if (calls >= L.maxToolCalls) { results.push({ type: 'tool_result', tool_use_id: u.type === 'tool_use' ? u.id : '', is_error: true, content: JSON.stringify({ ok: false, error: 'Tool call limit reached for this request. Answer with what you already have, or say what is missing.' }) }); continue; }
        calls++; const tu = u as { id: string; name: string; input: unknown }; const t0 = Date.now();
        const out = await executeTool(ctxWithConv, tu.name, tu.input, L.toolTimeoutMs);
        let argsJson: unknown = {}; try { const s = JSON.stringify(tu.input ?? {}); argsJson = s.length <= 3500 ? JSON.parse(s) : { truncated: true }; } catch { argsJson = { invalid: true }; }
        await ctx.rpc('ai_log_tool_call', { p_org: ctx.org, p_conv: conv, p_tool: String(tu.name).slice(0, 60), p_args: argsJson, p_ok: out.ok, p_count: out.count ?? null, p_error: out.error ?? null, p_ms: Date.now() - t0 });
        if (out.ok && (tu.name === 'propose_module_changes' || tu.name === 'propose_automation')) { const id = (JSON.parse(out.content) as { data?: { proposal_id?: string } }).data?.proposal_id; if (id) proposalIds.push(id); }
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: !out.ok, content: out.content });
      }
      norm.push({ role: 'user', content: results });
    }
  } catch (e) { return await fail(errorFor(e), e instanceof AiProviderError ? e.kind : 'error'); }
}
