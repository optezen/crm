// CRM backend service. No Next.js imports: the UI (server actions / pages) and future integration adapters call the same
// functions with a CrmContext. Reads go through RLS-protected views/tables; every write is a database RPC that
// re-checks membership, role and input, and writes the activity row + domain event in the same transaction.
import { MANAGER_ROLES, PAGE_SIZE, type ActivityRow, type CrmContext, type LeadInput, type LeadListParams, type LeadRow, type MemberRow, type NewLeadInput, type Result, type TaskInput, type TaskRow } from './types.ts';
import { isUuid, pageRange, validateLead, validateNewLead, validateNote, validateOutcome, validateTask } from './validate.ts';
import type { Role } from '../workspace/types.ts';

type Err = { code?: string; message: string } | null;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
/** Only messages raised deliberately by our SQL (22023 invalid, 23505 duplicate, P0002 not found) reach the user. */
function dbError(e: NonNullable<Err>): { ok: false; error: string } {
  if (e.code === '22023' || e.code === '23505' || e.code === 'P0002') return fail(e.message);
  if (e.code === '42501') return fail('You do not have permission to do that.');
  return fail('Something went wrong. Please try again.');
}
const NOT_FOUND = 'Not found.';

type LeadDb = { id: string; stage: string; source: LeadRow['source']; summary: string | null; assigned_to: string | null; created_at: string; updated_at: string; contact_id: string; full_name: string; phone: string | null; email: string | null; open_tasks: number; contact_hidden?: boolean };
const toLead = (r: LeadDb): LeadRow => ({ id: r.id, stage: r.stage, source: r.source, summary: r.summary, assignedTo: r.assigned_to, createdAt: r.created_at, updatedAt: r.updated_at, contactId: r.contact_id, fullName: r.full_name, phone: r.phone, email: r.email, contactHidden: !!r.contact_hidden, openTasks: r.open_tasks });

export const isManager = (role: Role) => MANAGER_ROLES.includes(role);

// ---------- reads ----------
export async function listLeads(ctx: CrmContext, p: LeadListParams): Promise<Result<{ rows: LeadRow[]; total: number; page: number; pageCount: number }>> {
  const { from, to } = pageRange(p.page);
  let q = ctx.db.from('crm_lead_list').select('*', { count: 'exact' }).eq('organization_id', ctx.organizationId);
  if (p.stage) q = q.eq('stage', p.stage);
  if (p.source) q = q.eq('source', p.source);
  if (p.assignee === 'unassigned') q = q.is('assigned_to', null);
  else if (p.assignee) q = q.eq('assigned_to', p.assignee === 'me' ? ctx.userId : p.assignee);
  if (p.q) {
    const digits = p.q.replace(/[^0-9+]/g, '');
    q = q.or([`full_name.ilike.%${p.q}%`, `email.ilike.%${p.q}%`, `summary.ilike.%${p.q}%`, ...(digits.length >= 3 ? [`phone.ilike.%${digits}%`] : [])].join(','));
  }
  // ponytail: offset pagination; switch to keyset (created_at, id) if a single organization grows past ~100k leads
  const { data, count, error } = await q.order('created_at', { ascending: false }).order('id').range(from, to);
  if (error) return dbError(error);
  const total = count ?? 0;
  return { ok: true, value: { rows: (data as LeadDb[]).map(toLead), total, page: p.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) } };
}

export async function getLead(ctx: CrmContext, leadId: string): Promise<Result<{ lead: LeadRow; activities: ActivityRow[]; tasks: TaskRow[] }>> {
  if (!isUuid(leadId)) return fail(NOT_FOUND);
  const { data: lead, error } = await ctx.db.from('crm_lead_list').select('*').eq('organization_id', ctx.organizationId).eq('id', leadId).maybeSingle();
  if (error) return dbError(error);
  if (!lead) return fail(NOT_FOUND); // missing and not-visible look identical
  const [acts, tasks] = await Promise.all([
    ctx.db.from('lead_activities').select('id, kind, body, meta, actor_id, created_at').eq('organization_id', ctx.organizationId).eq('lead_id', leadId).order('created_at', { ascending: false }).order('seq', { ascending: false }).limit(200),
    ctx.db.from('tasks').select('id, lead_id, title, owner_id, due_date, status, outcome, completed_at').eq('organization_id', ctx.organizationId).eq('lead_id', leadId).order('status', { ascending: false }).order('due_date').limit(200),
  ]);
  if (acts.error) return dbError(acts.error);
  if (tasks.error) return dbError(tasks.error);
  return { ok: true, value: {
    lead: toLead(lead as LeadDb),
    activities: acts.data.map(a => ({ id: a.id, kind: a.kind, body: a.body, meta: a.meta ?? {}, actorId: a.actor_id, createdAt: a.created_at })),
    tasks: tasks.data.map(t => ({ id: t.id, leadId: t.lead_id, title: t.title, ownerId: t.owner_id, dueDate: t.due_date, status: t.status, outcome: t.outcome, completedAt: t.completed_at })),
  } };
}

export async function stageCounts(ctx: CrmContext): Promise<Result<Record<string, number>>> {
  const { data, error } = await ctx.db.from('crm_stage_counts').select('stage, n').eq('organization_id', ctx.organizationId);
  if (error) return dbError(error);
  return { ok: true, value: Object.fromEntries(data.map(r => [r.stage, r.n])) };
}

/** My open follow-ups, soonest first, with the lead's name (only leads I can open are joined). */
export async function myOpenTasks(ctx: CrmContext, limit = 8): Promise<Result<(TaskRow & { leadName: string | null })[]>> {
  const { data, error } = await ctx.db.from('tasks').select('id, lead_id, title, owner_id, due_date, status, outcome, completed_at')
    .eq('organization_id', ctx.organizationId).eq('owner_id', ctx.userId).eq('status', 'open').order('due_date').limit(limit);
  if (error) return dbError(error);
  const ids = [...new Set(data.map(t => t.lead_id))];
  const names = new Map<string, string>();
  if (ids.length) {
    const l = await ctx.db.from('crm_lead_list').select('id, full_name').eq('organization_id', ctx.organizationId).in('id', ids);
    if (l.error) return dbError(l.error);
    l.data.forEach(r => names.set(r.id, r.full_name));
  }
  return { ok: true, value: data.map(t => ({ id: t.id, leadId: t.lead_id, title: t.title, ownerId: t.owner_id, dueDate: t.due_date, status: t.status, outcome: t.outcome, completedAt: t.completed_at, leadName: names.get(t.lead_id) ?? null })) };
}

export async function listMembers(ctx: CrmContext): Promise<Result<MemberRow[]>> {
  const { data, error } = await ctx.db.rpc('crm_list_members', { p_org: ctx.organizationId });
  if (error) return dbError(error);
  return { ok: true, value: (data as { user_id: string; role: Role; email: string }[]).map(m => ({ userId: m.user_id, role: m.role, email: m.email })) };
}

// ---------- writes ----------
export async function createLead(ctx: CrmContext, raw: Record<string, unknown>): Promise<Result<{ id: string }>> {
  const v = validateNewLead(raw, ctx.stages); if (!v.ok) return v;
  return createLeadValidated(ctx, v.value);
}
async function createLeadValidated(ctx: CrmContext, i: NewLeadInput): Promise<Result<{ id: string }>> {
  const { data, error } = await ctx.db.rpc('crm_create_lead', { p_org: ctx.organizationId, p_full_name: i.fullName, p_phone: i.phone, p_email: i.email, p_source: i.source, p_summary: i.summary, p_stage: i.stage, p_assigned_to: i.assignedTo });
  return error ? dbError(error) : { ok: true, value: { id: data as string } };
}

async function call(ctx: CrmContext, fn: string, args: Record<string, unknown>): Promise<Result<null>> {
  const { error } = await ctx.db.rpc(fn, { p_org: ctx.organizationId, ...args });
  return error ? dbError(error) : { ok: true, value: null };
}

export async function updateLead(ctx: CrmContext, leadId: string, raw: Record<string, unknown>): Promise<Result<null>> {
  if (!isUuid(leadId)) return fail(NOT_FOUND);
  const v = validateLead(raw); if (!v.ok) return v;
  const i: LeadInput = v.value;
  return call(ctx, 'crm_update_lead', { p_lead: leadId, p_full_name: i.fullName, p_phone: i.phone, p_email: i.email, p_source: i.source, p_summary: i.summary });
}
export async function setStage(ctx: CrmContext, leadId: string, stage: unknown): Promise<Result<null>> {
  if (!isUuid(leadId)) return fail(NOT_FOUND);
  if (typeof stage !== 'string' || !ctx.stages.includes(stage)) return fail('Choose a stage from the pipeline.');
  return call(ctx, 'crm_set_stage', { p_lead: leadId, p_stage: stage });
}
export async function assignLead(ctx: CrmContext, leadId: string, assigneeId: string | null): Promise<Result<null>> {
  if (!isUuid(leadId)) return fail(NOT_FOUND);
  if (assigneeId !== null && !isUuid(assigneeId)) return fail('Choose a valid assignee.');
  return call(ctx, 'crm_assign_lead', { p_lead: leadId, p_assignee: assigneeId });
}
export async function addNote(ctx: CrmContext, leadId: string, body: unknown): Promise<Result<null>> {
  if (!isUuid(leadId)) return fail(NOT_FOUND);
  const v = validateNote(body); if (!v.ok) return v;
  return call(ctx, 'crm_add_note', { p_lead: leadId, p_body: v.value });
}
export async function createTask(ctx: CrmContext, raw: Record<string, unknown>): Promise<Result<{ id: string }>> {
  const v = validateTask(raw); if (!v.ok) return v;
  const t: TaskInput = v.value;
  const { data, error } = await ctx.db.rpc('crm_create_task', { p_org: ctx.organizationId, p_lead: t.leadId, p_title: t.title, p_owner: t.ownerId, p_due: t.dueDate });
  return error ? dbError(error) : { ok: true, value: { id: data as string } };
}
export async function completeTask(ctx: CrmContext, taskId: string, outcome: unknown): Promise<Result<null>> {
  if (!isUuid(taskId)) return fail('Task not found.');
  const v = validateOutcome(outcome); if (!v.ok) return v;
  return call(ctx, 'crm_complete_task', { p_task: taskId, p_outcome: v.value });
}
export async function addMember(ctx: CrmContext, email: unknown, role: unknown): Promise<Result<null>> {
  if (typeof email !== 'string' || typeof role !== 'string') return fail('Enter an email address and choose a role.');
  return call(ctx, 'crm_add_member', { p_email: email.trim().toLowerCase(), p_role: role });
}
export async function setMemberRole(ctx: CrmContext, userId: string, role: unknown): Promise<Result<null>> {
  if (!isUuid(userId) || typeof role !== 'string') return fail('Team member not found.');
  return call(ctx, 'crm_set_member_role', { p_user: userId, p_role: role });
}
