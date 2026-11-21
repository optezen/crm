// Server-side tools the assistant may call. Every tool: fixed name, typed schema, strict validation, hard limits, and NO organization argument (the organization
// and the user come from the authenticated session). Reads go through ai_tool_* SQL functions that run as the user, so row level security and role checks apply
// in the database itself. Nothing here can run SQL, code or write configuration: the two propose_* tools only store a PROPOSAL that a human must approve.
import type { WorkspaceConfig } from '../workspace/types.ts';
import { LEAD_SOURCES } from '../crm/types.ts';
import { validateAutomation, describeAutomation } from '../automation/validate.ts';
import { TRIGGERS, ACTION_TYPES, CONDITION_OPS, scopeOf } from '../automation/types.ts';
import { check, toJsonSchema, type ObjectSchema } from './schema.ts';
import { applyOps, OPS_SCHEMA, type Op } from './config-ops.ts';
import { sanitizeUntrusted, UNTRUSTED_NOTICE } from './injection.ts';
import type { ToolSpec } from './provider.ts';

export type Role = 'owner' | 'admin' | 'manager' | 'employee';
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
export type ToolCtx = {
  org: string; userId: string; role: Role; conversationId: string | null; rpc: Rpc;
  loadConfigs: () => Promise<{ published: WorkspaceConfig; publishedRevision: number; draft: WorkspaceConfig | null }>;
  platformMissing: () => { meta: string[]; whatsapp: string[] }; // names of missing platform settings only, never values
};
export class ToolError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'unavailable';
  constructor(message: string, code: 'forbidden' | 'not_found' | 'invalid' | 'unavailable') { super(message); this.name = 'ToolError'; this.code = code; }
}
export type ToolResult = { data: unknown; count?: number };
export type ToolDef = { name: string; description: string; schema: ObjectSchema; roles: readonly Role[]; run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<ToolResult> };

const ALL: readonly Role[] = ['owner', 'admin', 'manager', 'employee'], ADMIN: readonly Role[] = ['owner', 'admin'], MANAGER: readonly Role[] = ['owner', 'admin', 'manager'];
const ISO = '^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.+Zz-]{1,30})?$';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const LIMIT = (max: number) => ({ type: 'integer' as const, minimum: 1, maximum: max, description: `Page size (default 10, maximum ${max}).` });
const OFFSET = { type: 'integer' as const, minimum: 0, maximum: 10000, description: 'Rows to skip, for the next page.' };
const none: ObjectSchema = { type: 'object', properties: {} };

/** Runs an ai_tool_* database function as the signed-in user. Database errors are mapped to safe, curated messages. */
async function db(ctx: ToolCtx, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await ctx.rpc(fn, { p_org: ctx.org, ...args });
  if (error) {
    if (error.code === '42501') throw new ToolError(error.message, 'forbidden');
    if (error.code === 'P0002') throw new ToolError(error.message, 'not_found');
    if (error.code === '22023') throw new ToolError(error.message, 'invalid');
    if (['22007', '22008', '22P02'].includes(error.code ?? '')) throw new ToolError('One of the values (a date or an id) is not valid.', 'invalid');
    throw new ToolError('The data could not be loaded right now.', 'unavailable'); // internal details are never shown to the model or the user
  }
  return data;
}
const items = (d: unknown) => ((d as { items?: unknown[] })?.items?.length ?? undefined);
const read = (fn: string, map: (a: Record<string, unknown>) => Record<string, unknown>) => async (ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> => { const data = await db(ctx, fn, map(a)); return { data, count: items(data) }; };

const SUPPORTED = `Supported triggers: ${TRIGGERS.filter(t => t.available).map(t => t.event).join(', ')}. Conditions (op): ${CONDITION_OPS.join(', ')}. Actions: ${ACTION_TYPES.join(', ')}.`;

export const TOOLS: ToolDef[] = [
  { name: 'list_leads', roles: ALL, description: 'List real CRM leads the user is allowed to see, newest first, with filters and pagination. Contact details are not included.',
    schema: { type: 'object', properties: { stage: { type: 'string', maxLength: 80 }, source: { type: 'string', enum: LEAD_SOURCES }, assignee: { type: 'string', pattern: `^(me|unassigned|${UUID.slice(1, -1)})$`, description: '"me", "unassigned" or a user id.' },
      search: { type: 'string', maxLength: 80, description: 'Part of the contact name.' }, limit: LIMIT(25), offset: OFFSET } },
    run: read('ai_tool_list_leads', a => ({ p_stage: a.stage ?? null, p_source: a.source ?? null, p_assignee: a.assignee ?? null, p_search: a.search ?? null, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'get_lead', roles: ALL, description: 'Details of one lead: stage, source, assignee, recent activity notes, tasks and attribution. Phone and email are masked unless include_contact is true; set it only when the user explicitly asks for contact details.',
    schema: { type: 'object', properties: { lead_id: { type: 'string', pattern: UUID }, include_contact: { type: 'boolean' } }, required: ['lead_id'] },
    run: read('ai_tool_get_lead', a => ({ p_lead: a.lead_id, p_include_contact: a.include_contact ?? false })) },
  { name: 'list_pending_tasks', roles: ALL, description: 'Open follow-up tasks, soonest due first. owner: "me" (default), "all" or a user id. Only tasks on leads the user can see are returned.',
    schema: { type: 'object', properties: { owner: { type: 'string', pattern: `^(me|all|${UUID.slice(1, -1)})$` }, overdue_only: { type: 'boolean' }, limit: LIMIT(25), offset: OFFSET } },
    run: read('ai_tool_list_tasks', a => ({ p_owner: a.owner ?? 'me', p_overdue: a.overdue_only ?? false, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'get_team_summary', roles: ALL, description: 'Team size by role. Owners, admins and managers also get per-member open tasks and assigned leads.', schema: none, run: read('ai_tool_team_summary', () => ({})) },
  { name: 'list_modules', roles: ALL, description: 'The workspace modules (core and custom), their status, field definitions and record counts, plus the lead pipeline stages.', schema: none, run: read('ai_tool_list_modules', () => ({})) },
  { name: 'list_module_records', roles: ALL, description: 'Records of ONE custom module, newest first, with pagination. Use list_modules first to get the module key. Phone/email values are masked.',
    schema: { type: 'object', properties: { module: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 40 }, search: { type: 'string', maxLength: 80 }, limit: LIMIT(25), offset: OFFSET }, required: ['module'] },
    run: read('ai_tool_list_module_records', a => ({ p_module: a.module, p_search: a.search ?? null, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'get_connection_status', roles: ADMIN, description: 'Status of integrations (website forms, Meta, WhatsApp, ...): connected / setup required / expired / error, last event, last error, and which providers are not supported yet. Owners and admins only. Never includes credentials.', schema: none,
    run: async ctx => { const data = (await db(ctx, 'ai_tool_connection_status', {})) as Record<string, unknown>; return { data: { ...data, platform_settings_missing: ctx.platformMissing(), note: 'A provider is only usable when its status is "connected". Google Ads, telephony and payments are not implemented.' }, count: (data.connections as unknown[] | undefined)?.length }; } },
  { name: 'get_integration_errors', roles: ADMIN, description: 'Recent integration errors (rejected submissions, failed deliveries, expired tokens). Owners and admins only.', schema: { type: 'object', properties: { limit: LIMIT(20) } },
    run: read('ai_tool_integration_errors', a => ({ p_limit: a.limit ?? 10 })) },
  { name: 'list_workflows', roles: ADMIN, description: 'Automations: name, enabled, trigger, number of actions and last run. Owners and admins only.', schema: none, run: read('ai_tool_list_workflows', () => ({})) },
  { name: 'get_workflow_runs', roles: ADMIN, description: 'Recent automation runs with status, errors and step results. Owners and admins only.',
    schema: { type: 'object', properties: { workflow_id: { type: 'string', pattern: UUID }, status: { type: 'string', enum: ['queued', 'waiting', 'retrying', 'succeeded', 'dead', 'cancelled', 'skipped'] }, limit: LIMIT(20) } },
    run: read('ai_tool_workflow_runs', a => ({ p_workflow: a.workflow_id ?? null, p_status: a.status ?? null, p_limit: a.limit ?? 10 })) },

  { name: 'get_operations_status', roles: ALL, description: 'Whether the optional Appointments, Inventory and Billing modules are enabled for this workspace, their key rules and how much master data exists. Billing details are only for owners, admins and managers.', schema: none, run: read('ai_tool_operations_status', () => ({})) },
  { name: 'list_appointments', roles: ALL, description: 'Appointments in a date range (default: the last 7 and next 30 days), with optional staff and status filters. Customer names are shown only where the user can see the contact. Appointment reminders are NOT sent by Optizen (no messaging provider is connected).',
    schema: { type: 'object', properties: { from: { type: 'string', pattern: ISO, description: 'ISO start of range.' }, to: { type: 'string', pattern: ISO, description: 'ISO end of range (at most 92 days after from).' }, staff: { type: 'string', pattern: `^(me|${UUID.slice(1, -1)})$` },
      status: { type: 'string', enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] }, limit: LIMIT(25), offset: OFFSET } },
    run: read('ai_tool_list_appointments', a => ({ p_from: a.from ?? null, p_to: a.to ?? null, p_staff: a.staff ?? null, p_status: a.status ?? null, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'get_inventory_status', roles: ALL, description: 'Products with quantity on hand, low-stock flags and lots expiring within 30 days. Use low_stock_only for what needs reordering.',
    schema: { type: 'object', properties: { search: { type: 'string', maxLength: 80 }, low_stock_only: { type: 'boolean' }, limit: LIMIT(25), offset: OFFSET } },
    run: read('ai_tool_inventory_status', a => ({ p_search: a.search ?? null, p_low_only: a.low_stock_only ?? false, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'list_stock_movements', roles: ALL, description: 'The immutable stock ledger, newest first, optionally for one product.',
    schema: { type: 'object', properties: { product_id: { type: 'string', pattern: UUID }, limit: LIMIT(25) } }, run: read('ai_tool_stock_movements', a => ({ p_product: a.product_id ?? null, p_limit: a.limit ?? 10 })) },
  { name: 'list_invoices', roles: MANAGER, description: 'Invoices with totals, payments, credits, balance due and overdue flags, computed from the ledger. state: draft, issued, cancelled, unpaid, partially_paid, paid or credit. Owners, admins and managers only. "paid" means a payment recorded by staff; it does not confirm any external payment processing.',
    schema: { type: 'object', properties: { state: { type: 'string', enum: ['draft', 'issued', 'cancelled', 'unpaid', 'partially_paid', 'paid', 'credit'] }, limit: LIMIT(25), offset: OFFSET } },
    run: read('ai_tool_list_invoices', a => ({ p_state: a.state ?? null, p_limit: a.limit ?? 10, p_offset: a.offset ?? 0 })) },
  { name: 'get_billing_summary', roles: MANAGER, description: 'Totals per currency: invoiced, outstanding, overdue and credit owed, from the ledger. Owners, admins and managers only.', schema: none, run: read('ai_tool_billing_summary', () => ({})) },

  { name: 'propose_module_changes', roles: ADMIN,
    description: 'Prepare a DRAFT change to the workspace configuration (new module, new fields, renames, hiding a field, or enabling/disabling the optional Appointments, Inventory and Billing modules). Nothing is saved or published: the user reviews a preview and diff and must approve. Use list_modules first for existing module keys. Fields: text, number, date, choice (dropdown, needs options), yes_no (checkbox), phone, email, currency. Not supported: relations between modules, formulas, per-module permissions, deleting modules or data.',
    schema: OPS_SCHEMA,
    run: async (ctx, a) => {
      const cfgs = await ctx.loadConfigs(); const base = cfgs.draft ?? cfgs.published;
      const r = applyOps(base, cfgs.published, (a.operations as Op[]));
      if (!r.ok) throw new ToolError(r.error, 'invalid');
      if (r.value.diff.length === 0) throw new ToolError('That would not change anything in the current configuration.', 'invalid');
      const payload = { summary: a.summary, operations: a.operations, config: r.value.config, diff: r.value.diff, built_on: cfgs.draft ? 'the saved draft' : 'the live version' };
      const id = await db(ctx, 'ai_create_proposal', { p_conv: ctx.conversationId, p_kind: 'module_config', p_title: String(a.summary), p_payload: payload, p_base_revision: cfgs.publishedRevision });
      return { data: { proposal_id: id, status: 'pending_user_approval', diff: r.value.diff, built_on: payload.built_on, next_step: 'The user sees a preview with Approve buttons in the chat. Nothing is saved, published or live until they approve. Do not say it is done.' }, count: r.value.diff.length };
    } },
  { name: 'propose_automation', roles: ADMIN,
    description: `Prepare a DRAFT automation in the existing grammar: {"trigger":{"event":"lead.created"},"match":{"op":"and","conditions":[{"field":"lead.source","op":"eq","value":"website"}]},"actions":[{"type":"assign_round_robin"},{"type":"create_task","title":"Call {{lead.full_name}}","due_in_days":1,"owner":"lead_assignee"}]}. ${SUPPORTED} Condition fields: lead.stage/source/summary/assigned_to/full_name/phone/email/created_at, task.title/status/owner_id/due_date/outcome, record.<field key>. Actions: assign_round_robin {roles?,only_if_unassigned?}, create_task {title,due_in_days,owner:"lead_assignee"}, update_task_status {status,outcome?}, update_record {field,value}, notify {recipient:"lead_assignee"|"task_owner"|"event_actor",title,body?}, wait {minutes|until_field}, request_integration {channel,message,to:"lead_contact"}. Specific people cannot be named; appointment/payment triggers do not exist yet. Nothing is saved or enabled: the user must approve.`,
    schema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, summary: { type: 'string', minLength: 3, maxLength: 160 }, definition: { type: 'free_object', maxBytes: 30000, description: 'The automation definition in the grammar above.' } }, required: ['name', 'summary', 'definition'] },
    run: async (ctx, a) => {
      const v = validateAutomation(a.definition);
      if (!v.ok) throw new ToolError(`${v.error} ${SUPPORTED}`, 'invalid');
      const def = v.value, trig = TRIGGERS.find(t => t.event === def.trigger.event);
      if (!trig?.available) throw new ToolError(`The trigger "${def.trigger.event}" is not available yet (there is no ${def.trigger.event.split('.')[0]} module). ${SUPPORTED}`, 'invalid');
      const UUID_RE = new RegExp(UUID);
      for (const [i, x] of def.actions.entries()) {
        if (x.type === 'assign_lead' || (x.type === 'create_task' && UUID_RE.test(x.owner)) || (x.type === 'notify' && UUID_RE.test(x.recipient)))
          throw new ToolError(`Action ${i + 1} names a specific person. The assistant cannot pick people: use round-robin, "lead_assignee" or "event_actor", or set the person manually in the Automation Builder after saving the draft.`, 'invalid');
      }
      const warnings: string[] = [];
      if (scopeOf(def.trigger.event) === 'record') {
        const { published } = await ctx.loadConfigs(); const obj = published.objects.find(o => o.key === def.trigger.object);
        if (!def.trigger.object || !obj) throw new ToolError('Record triggers need an existing custom module (use list_modules for the key).', 'invalid');
        for (const x of def.actions) if (x.type === 'update_record' && !obj.fields.some(f => f.key === x.field && !f.archived)) throw new ToolError(`The field "${x.field}" does not exist (or is hidden) in module "${obj.label}".`, 'invalid');
      }
      if (def.actions.some(x => x.type === 'request_integration')) {
        const st = (await db(ctx, 'ai_tool_connection_status', {})) as { connections?: { provider: string; status: string }[] };
        for (const x of def.actions) if (x.type === 'request_integration') {
          const connected = x.channel === 'whatsapp' && st.connections?.some(c => c.provider === 'whatsapp' && c.status === 'connected');
          warnings.push(connected ? `WhatsApp is connected: the message will be sent only with the approved template configured on the connection.`
            : x.channel === 'whatsapp' ? 'WhatsApp is NOT connected. This action would only queue a request; nothing would be sent until a WhatsApp connection is set up in Connections.'
            : `There is no ${x.channel} provider. This action would only record a request; nothing would be sent.`);
        }
      }
      const preview = describeAutomation(def);
      const payload = { name: a.name, summary: a.summary, definition: def, preview, warnings };
      const id = await db(ctx, 'ai_create_proposal', { p_conv: ctx.conversationId, p_kind: 'workflow', p_title: String(a.name), p_payload: payload, p_base_revision: null });
      return { data: { proposal_id: id, status: 'pending_user_approval', preview, warnings, next_step: 'The user sees the preview with Approve buttons in the chat. Nothing is saved or enabled until they approve. Do not say it is active.' }, count: def.actions.length };
    } },
];

export const toolsFor = (role: Role) => TOOLS.filter(t => t.roles.includes(role));
export const toolSpecs = (role: Role): ToolSpec[] => toolsFor(role).map(t => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.schema) }));

export type Outcome = { ok: boolean; content: string; count?: number; error?: string; code?: string; withheld?: number };
const MAX_RESULT_CHARS = 14000;
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => { const t = setTimeout(() => rej(new ToolError('The lookup took too long.', 'unavailable')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

/** Validates, authorizes, runs (with a timeout) and packages one tool call. Never throws; the outcome is fed back to the model as a tool_result. */
export async function executeTool(ctx: ToolCtx, name: string, input: unknown, timeoutMs = 8000): Promise<Outcome> {
  const fail = (error: string, code: string): Outcome => ({ ok: false, error, code, content: JSON.stringify({ ok: false, error }) });
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return fail(`Unknown tool "${name}". Available tools: ${toolsFor(ctx.role).map(t => t.name).join(', ')}.`, 'unknown_tool');
  if (!tool.roles.includes(ctx.role)) return fail(`The "${name}" tool is not available for your role (${ctx.role}). Tell the user this needs an owner or admin.`, 'forbidden');
  const v = check(tool.schema, input ?? {});
  if (!v.ok) return fail(`Invalid arguments: ${v.error}`, 'invalid_arguments');
  try {
    const r = await withTimeout(tool.run(ctx, v.value as Record<string, unknown>), timeoutMs);
    const clean = sanitizeUntrusted(r.data);
    let body = { ok: true, tool: name, notice: UNTRUSTED_NOTICE, ...(clean.withheld ? { withheld_possible_instructions: clean.withheld } : {}), data: clean.value } as Record<string, unknown>;
    let text = JSON.stringify(body);
    if (text.length > MAX_RESULT_CHARS) {
      const d = clean.value as { items?: unknown[] }; if (Array.isArray(d?.items)) { const keep = d.items.slice(0, Math.max(1, Math.floor(d.items.length * MAX_RESULT_CHARS / text.length))); body = { ...body, data: { ...d, items: keep }, truncated: true }; text = JSON.stringify(body); }
      if (text.length > MAX_RESULT_CHARS) text = JSON.stringify({ ok: true, tool: name, truncated: true, error: 'The result was too large; ask for a smaller page.' });
    }
    return { ok: true, content: text, count: r.count, withheld: clean.withheld };
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message, e.code);
    return fail('The data could not be loaded right now.', 'unavailable');
  }
}
