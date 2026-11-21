// One conversation turn: budget check -> persist the user message -> model <-> tool loop (bounded) -> persist the answer -> usage + audit.
// The model can only call the registered tools; it has no access to SQL, code execution or the network. Every limit below is a hard stop.
import { AiProviderError, type ChatMessage, type CompleteResponse, type ModelProvider, type ToolResultBlock } from './provider.ts';
import { executeTool, toolSpecs, type ToolCtx } from './tools.ts';
import { systemPrompt } from './prompt.ts';

export type Limits = { maxSteps: number; maxToolCalls: number; maxOutputTokens: number; maxTokensPerCall: number; turnTimeoutMs: number; toolTimeoutMs: number; historyMessages: number };
export const DEFAULT_LIMITS: Limits = { maxSteps: 6, maxToolCalls: 8, maxOutputTokens: 8000, maxTokensPerCall: 1200, turnTimeoutMs: 55_000, toolTimeoutMs: 8_000, historyMessages: 12 };
export type TurnError = { code: 'not_configured' | 'invalid_message' | 'budget' | 'not_found' | 'busy' | 'unavailable' | 'provider_auth' | 'invalid_output' | 'limit' | 'timeout' | 'cancelled' | 'in_progress'; message: string };
export type TurnResult = { ok: true; conversationId: string; text: string; proposalIds: string[]; planIds: string[]; toolCalls: number; replayed?: boolean } | { ok: false; conversationId: string | null; error: TurnError };
/** What a live client may see: step progress, answer text, ids of proposals. Never tool arguments, tool results, credentials or model-internal reasoning. */
export type TurnEvent = { type: 'start'; conversationId: string } | { type: 'text'; text: string } | { type: 'reset' } | { type: 'tool_start'; name: string; label: string } | { type: 'tool_end'; name: string; ok: boolean } | { type: 'proposal'; id: string } | { type: 'plan'; id: string };
export const TOOL_LABEL: Record<string, string> = { list_leads: 'Looking up leads', get_lead: 'Reading a lead', list_pending_tasks: 'Checking follow-up tasks', get_team_summary: 'Checking the team', list_modules: 'Reading your modules', list_module_records: 'Reading records', get_connection_status: 'Checking connections', get_integration_errors: 'Checking integration errors',
  list_workflows: 'Reading automations', get_workflow_runs: 'Reading automation runs', get_operations_status: 'Checking business modules', list_appointments: 'Looking up appointments', get_inventory_status: 'Checking inventory', list_stock_movements: 'Reading the stock ledger', list_invoices: 'Looking up invoices', get_billing_summary: 'Summarising billing',
  get_analytics_catalog: 'Checking available metrics', query_analytics: 'Running a report', propose_dashboard: 'Preparing a dashboard', propose_module_changes: 'Preparing a configuration change', propose_automation: 'Preparing a workflow', propose_plan: 'Preparing a multi-step plan', propose_lead_update: 'Preparing a lead change', propose_assignment: 'Preparing an assignment', propose_task: 'Preparing a task' };

const errorFor = (e: unknown): TurnError => {
  if (e instanceof AiProviderError) {
    if (e.kind === 'auth') return { code: 'provider_auth', message: 'The AI assistant is not configured correctly (its API key was rejected). Ask an administrator.' };
    if (e.kind === 'rate_limit') return { code: 'busy', message: 'The AI service is busy right now. Please try again in a minute.' };
    if (e.kind === 'invalid_output' || e.kind === 'parse') return { code: 'invalid_output', message: 'The AI returned a response Optizen could not use. Please try again or rephrase.' };
    if (e.kind === 'cancelled') return { code: 'cancelled', message: 'Cancelled.' };
    if (e.kind === 'timeout') return { code: 'timeout', message: 'The AI took too long to answer. Please try again.' };
    return { code: 'unavailable', message: 'The AI service is unavailable right now. Your records are unaffected. Please try again later.' };
  }
  return { code: 'unavailable', message: 'The assistant could not complete this request. Please try again.' };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type TurnDeps = { provider: ModelProvider | null; ctx: ToolCtx; businessName: string; limits?: Partial<Limits>; today?: string; retryDelayMs?: number; emit?: (e: TurnEvent) => void; signal?: AbortSignal; requestId?: string | null };

export async function runTurn(deps: TurnDeps, input: { conversationId?: string | null; message: unknown }): Promise<TurnResult> {
  const { ctx } = deps; const L = { ...DEFAULT_LIMITS, ...deps.limits }; const started = Date.now(); const emit = deps.emit ?? (() => {}); const signal = deps.signal;
  const text = typeof input.message === 'string' ? input.message.trim() : '';
  const err = (error: TurnError, conv: string | null = input.conversationId ?? null): TurnResult => ({ ok: false, conversationId: conv, error });
  if (!text || text.length > 4000) return err({ code: 'invalid_message', message: 'Write a message of up to 4000 characters.' });
  if (!deps.provider) return err({ code: 'not_configured', message: 'The AI assistant is not configured on this deployment (no model API key). Nothing was sent anywhere.' });
  const provider = deps.provider;
  const reqId = deps.requestId ?? null;

  // 1. idempotency: a retried request returns the stored answer instead of running again (so tools, usage and proposals are never duplicated)
  if (reqId) {
    const b = (await ctx.rpc('ai_request_begin', { p_org: ctx.org, p_request: reqId })).data as { state?: string; response?: { conversationId: string; text: string; proposalIds: string[]; planIds?: string[]; toolCalls: number } } | null;
    if (b?.state === 'done' && b.response) return { ok: true, replayed: true, conversationId: b.response.conversationId, text: b.response.text, proposalIds: b.response.proposalIds ?? [], planIds: b.response.planIds ?? [], toolCalls: b.response.toolCalls ?? 0 };
    if (b?.state === 'running') return err({ code: 'in_progress', message: 'That request is still being processed. Please wait a moment.' });
  }
  const release = async () => { if (reqId) await ctx.rpc('ai_request_release', { p_org: ctx.org, p_request: reqId }); };

  // 2. atomic reservation: capacity is claimed BEFORE the model runs, under a per-organization lock, so parallel requests cannot all pass a nearly-full budget
  const reserve = (await ctx.rpc('ai_reserve', { p_org: ctx.org, p_request: reqId, p_est: Math.min(L.maxOutputTokens, 8000) + 2000, p_kind: 'chat' })).data as { allowed?: boolean; reason?: string; usage_id?: string } | null;
  if (!reserve?.allowed || !reserve.usage_id) { await release(); return err({ code: 'budget', message: reserve?.reason ?? 'AI usage is not available right now.' }); }
  const usageId = reserve.usage_id; let settled = false;
  let inTok = 0, outTok = 0, calls = 0; let conv = input.conversationId ?? null;
  const settle = async (status: 'ok' | 'error' | 'cancelled', detail?: string) => { if (settled) return; settled = true; await ctx.rpc('ai_settle', { p_org: ctx.org, p_usage: usageId, p_provider: provider.id, p_model: provider.model, p_in: inTok, p_out: outTok, p_tools: calls, p_status: status, p_error: detail ?? null, p_ms: Date.now() - started, p_conv: conv }); };
  const fail = async (e: TurnError, detail?: string): Promise<TurnResult> => { await settle(e.code === 'cancelled' ? 'cancelled' : 'error', detail ?? e.code); await release(); return err(e, conv); };

  try {
    // 3. conversation + user message
    if (!conv) { const c = await ctx.rpc('ai_create_conversation', { p_org: ctx.org, p_title: text.slice(0, 80) }); if (c.error) return await fail({ code: 'unavailable', message: 'Could not start a conversation.' }); conv = c.data as string; }
    const added = await ctx.rpc('ai_add_message', { p_org: ctx.org, p_conv: conv, p_role: 'user', p_content: { text } });
    if (added.error) return await fail(added.error.code === 'P0002' ? { code: 'not_found', message: 'That conversation was not found.' } : { code: 'unavailable', message: 'Could not save your message.' });
    emit({ type: 'start', conversationId: conv });
    const ctxWithConv: ToolCtx = { ...ctx, conversationId: conv };

    const hist = ((await ctx.rpc('ai_recent_messages', { p_org: ctx.org, p_conv: conv, p_limit: L.historyMessages })).data as { role: 'user' | 'assistant'; text: string }[] | null) ?? [];
    const messages: ChatMessage[] = hist.filter(m => m.text).map(m => ({ role: m.role, content: m.text }));
    if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: text });
    const norm: ChatMessage[] = []; for (const m of messages) { const last = norm[norm.length - 1]; if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n' + m.content; else norm.push({ ...m }); }
    while (norm[0]?.role === 'assistant') norm.shift();

    const system = systemPrompt({ businessName: deps.businessName, role: ctx.role, today: deps.today ?? new Date().toISOString().slice(0, 10) });
    const tools = toolSpecs(ctx.role); const proposalIds: string[] = [], planIds: string[] = [];
    for (let step = 0; ; step++) {
      if (signal?.aborted) return await fail({ code: 'cancelled', message: 'Cancelled.' });
      if (step >= L.maxSteps) return await fail({ code: 'limit', message: 'The assistant needed too many steps for this request. Try a narrower question.' });
      if (Date.now() - started > L.turnTimeoutMs) return await fail({ code: 'timeout', message: 'This took too long. Try a narrower question.' });
      let resp: CompleteResponse; let streamedText = false;
      for (let attempt = 0; ; attempt++) {
        const req = { system, messages: norm, tools, maxTokens: L.maxTokensPerCall, timeoutMs: Math.max(1000, Math.min(30_000, L.turnTimeoutMs - (Date.now() - started))), signal };
        try { resp = deps.emit && provider.stream ? await provider.stream(req, e => { streamedText = true; emit({ type: 'text', text: e.text }); }) : await provider.complete(req); break; }
        catch (e) { if (attempt === 0 && !streamedText && e instanceof AiProviderError && e.retryable && !signal?.aborted) { await sleep(deps.retryDelayMs ?? 600); continue; } throw e; } // retry once (a pure read), but never after text was already shown
      }
      inTok += resp.usage.inputTokens; outTok += resp.usage.outputTokens;
      if (outTok > L.maxOutputTokens) return await fail({ code: 'limit', message: 'This request used too much AI capacity. Try a narrower question.' });
      const uses = resp.content.filter(b => b.type === 'tool_use');
      const answer = resp.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
      if (uses.length === 0) {
        if (!answer) throw new AiProviderError('Empty answer.', 'invalid_output');
        if (signal?.aborted) return await fail({ code: 'cancelled', message: 'Cancelled.' });
        await ctx.rpc('ai_add_message', { p_org: ctx.org, p_conv: conv, p_role: 'assistant', p_content: { text: answer, proposals: proposalIds, plans: planIds } });
        await settle('ok');
        const out = { conversationId: conv, text: answer, proposalIds, planIds, toolCalls: calls };
        if (reqId) await ctx.rpc('ai_request_finish', { p_org: ctx.org, p_request: reqId, p_response: out });
        return { ok: true, ...out };
      }
      if (streamedText) emit({ type: 'reset' }); // narration before a tool call is not part of the answer
      norm.push({ role: 'assistant', content: resp.content });
      const results: ToolResultBlock[] = [];
      for (const u of uses) {
        const tu = u as { id: string; name: string; input: unknown };
        if (signal?.aborted) return await fail({ code: 'cancelled', message: 'Cancelled.' });
        if (calls >= L.maxToolCalls) { results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ ok: false, error: 'Tool call limit reached for this request. Answer with what you already have, or say what is missing.' }) }); continue; }
        calls++; const t0 = Date.now(); emit({ type: 'tool_start', name: tu.name, label: TOOL_LABEL[tu.name] ?? 'Working' });
        const out = await executeTool(ctxWithConv, tu.name, tu.input, L.toolTimeoutMs);
        emit({ type: 'tool_end', name: tu.name, ok: out.ok });
        let argsJson: unknown = {}; try { const sj = JSON.stringify(tu.input ?? {}); argsJson = sj.length <= 3500 ? JSON.parse(sj) : { truncated: true }; } catch { argsJson = { invalid: true }; }
        await ctx.rpc('ai_log_tool_call', { p_org: ctx.org, p_conv: conv, p_tool: String(tu.name).slice(0, 60), p_args: argsJson, p_ok: out.ok, p_count: out.count ?? null, p_error: out.error ?? null, p_ms: Date.now() - t0 });
        if (out.ok) { const d = (JSON.parse(out.content) as { data?: { proposal_id?: string; plan_id?: string } }).data;
          if (d?.plan_id && tu.name === 'propose_plan') { planIds.push(d.plan_id); emit({ type: 'plan', id: d.plan_id }); }
          else if (d?.proposal_id && /^propose_/.test(tu.name)) { proposalIds.push(d.proposal_id); emit({ type: 'proposal', id: d.proposal_id }); } }
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: !out.ok, content: out.content });
      }
      norm.push({ role: 'user', content: results });
    }
  } catch (e) { return await fail(errorFor(e), e instanceof AiProviderError ? e.kind : 'error'); }
}
