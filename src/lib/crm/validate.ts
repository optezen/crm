// Pure input normalization/validation. Mirrors the checks in migration 0004 (which re-validates: defense in depth).
import { LEAD_SOURCES, PAGE_SIZE, type LeadInput, type LeadListParams, type LeadSource, type NewLeadInput, type Result, type TaskInput } from './types.ts';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const normalizeName = (v: unknown) => str(v).trim().replace(/\s+/g, ' ');
export const normalizePhone = (v: unknown) => str(v).replace(/[\s().-]/g, '');
export const normalizeEmail = (v: unknown) => str(v).trim().toLowerCase();
const blank = (s: string) => (s === '' ? null : s);

export function validateLead(raw: Record<string, unknown>): Result<LeadInput> {
  const fullName = normalizeName(raw.fullName);
  if (fullName.length < 1 || fullName.length > 120) return fail('Enter a name of up to 120 characters.');
  const phone = normalizePhone(raw.phone);
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) return fail('Enter a valid phone number (7 to 15 digits, optional leading +).');
  const email = normalizeEmail(raw.email);
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return fail('Enter a valid email address.');
  const source = str(raw.source) || 'other';
  if (!(LEAD_SOURCES as readonly string[]).includes(source)) return fail('Choose a valid lead source.');
  const summary = str(raw.summary).trim();
  if (summary.length > 2000) return fail('Summary must be at most 2000 characters.');
  return { ok: true, value: { fullName, phone: blank(phone), email: blank(email), source: source as LeadSource, summary: blank(summary) } };
}

export function validateNewLead(raw: Record<string, unknown>, stages: readonly string[]): Result<NewLeadInput> {
  const base = validateLead(raw);
  if (!base.ok) return base;
  const stage = str(raw.stage).trim();
  if (stage && !stages.includes(stage)) return fail('Choose a stage from the pipeline.');
  const assignedTo = str(raw.assignedTo);
  if (assignedTo && !isUuid(assignedTo)) return fail('Choose a valid assignee.');
  return { ok: true, value: { ...base.value, stage: blank(stage), assignedTo: blank(assignedTo) } };
}

export function validateNote(v: unknown): Result<string> {
  const body = str(v).trim();
  if (!body) return fail('Write a note first.');
  return body.length > 4000 ? fail('Note must be at most 4000 characters.') : { ok: true, value: body };
}

export function validateTask(raw: Record<string, unknown>): Result<TaskInput> {
  const title = str(raw.title).trim().replace(/\s+/g, ' ');
  if (!title) return fail('Enter a task title.');
  if (title.length > 200) return fail('Task title must be at most 200 characters.');
  if (!isUuid(raw.leadId)) return fail('Lead not found.');
  const ownerId = str(raw.ownerId);
  if (ownerId && !isUuid(ownerId)) return fail('Choose a valid owner.');
  const dueDate = str(raw.dueDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate))) return fail('Choose a due date.');
  return { ok: true, value: { leadId: raw.leadId, title, ownerId: blank(ownerId), dueDate } };
}

export function validateOutcome(v: unknown): Result<string> {
  const o = str(v).trim();
  if (!o) return fail('Record the outcome before completing the task.');
  return o.length > 1000 ? fail('Outcome must be at most 1000 characters.') : { ok: true, value: o };
}

/** Never throws: junk in the query string just falls back to defaults. */
export function parseListParams(sp: Record<string, string | string[] | undefined>, stages: readonly string[]): LeadListParams {
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ''; };
  const page = Number.parseInt(one('page'), 10);
  const stage = one('stage'), source = one('source'), assignee = one('assignee');
  return {
    page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
    q: one('q').replace(/[%_,()"\\*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80), // safe to embed in a PostgREST or()/ilike filter
    stage: stages.includes(stage) ? stage : null,
    source: (LEAD_SOURCES as readonly string[]).includes(source) ? (source as LeadSource) : null,
    sort: one('sort') === 'name' || one('sort') === 'updated' ? (one('sort') as 'name' | 'updated') : 'created',
    dir: one('dir') === 'asc' ? 'asc' : 'desc',
    assignee: assignee === 'me' || assignee === 'unassigned' || isUuid(assignee) ? assignee : null,
  };
}
export const pageRange = (page: number) => ({ from: (page - 1) * PAGE_SIZE, to: page * PAGE_SIZE - 1 });
