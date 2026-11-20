// Generic record service for custom modules. No Next.js imports: UI actions and future integration adapters call the same functions.
// Reads go through RLS (members of the organization only); every write is a database RPC that re-validates against the LIVE
// published configuration, re-checks membership/permissions, and writes the audit row + domain event in the same transaction.
import { RECORD_PAGE_SIZE, type RecordData, type RecordListParams, type RecordRow, type RecordsContext } from './types.ts';
import { findModule, validateRecord } from './validate.ts';
import type { Result } from '../workspace/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
function dbError(e: { code?: string; message: string }): { ok: false; error: string } {
  if (e.code === '22023' || e.code === '23505' || e.code === 'P0002' || e.code === '42501') return fail(e.code === '42501' && !/records you created/.test(e.message) ? 'You do not have permission to do that.' : e.message);
  return fail('Something went wrong. Please try again.');
}
type Row = { id: string; object_key: string; data: RecordData; created_by: string; updated_by: string; created_at: string; updated_at: string };
const toRow = (r: Row): RecordRow => ({ id: r.id, objectKey: r.object_key, data: r.data, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });

export async function listRecords(ctx: RecordsContext, moduleKey: string, p: RecordListParams): Promise<Result<{ rows: RecordRow[]; total: number; page: number; pageCount: number }>> {
  const m = findModule(ctx.config, moduleKey); if (!m) return fail('Module not found.');
  const from = (p.page - 1) * RECORD_PAGE_SIZE;
  let q = ctx.db.from('records').select('*', { count: 'exact' }).eq('organization_id', ctx.organizationId).eq('object_key', m.object.key);
  for (const [key, v] of Object.entries(p.filters)) {
    const f = m.object.fields.find(x => x.key === key); if (!f) continue; // keys come from the configuration, never from the request
    q = f.kind === 'yes_no' ? q.filter(`data->>${key}`, 'eq', v === 'yes' ? 'true' : 'false') : q.filter(`data->>${key}`, 'eq', v);
  }
  if (p.q) q = q.ilike('search_text', `%${p.q.toLowerCase()}%`); // ponytail: sequential ilike within one organization+module; add pg_trgm if a module passes ~100k records
  const { data, count, error } = await q.order('created_at', { ascending: false }).order('id').range(from, from + RECORD_PAGE_SIZE - 1);
  if (error) return dbError(error);
  const total = count ?? 0;
  return { ok: true, value: { rows: (data as Row[]).map(toRow), total, page: p.page, pageCount: Math.max(1, Math.ceil(total / RECORD_PAGE_SIZE)) } };
}

export async function getRecord(ctx: RecordsContext, moduleKey: string, id: string): Promise<Result<RecordRow>> {
  if (!UUID.test(id) || !findModule(ctx.config, moduleKey)) return fail('Record not found.');
  const { data, error } = await ctx.db.from('records').select('*').eq('organization_id', ctx.organizationId).eq('object_key', moduleKey).eq('id', id).maybeSingle();
  if (error) return dbError(error);
  return data ? { ok: true, value: toRow(data as Row) } : fail('Record not found.');
}

export async function createRecord(ctx: RecordsContext, moduleKey: string, input: Record<string, unknown>): Promise<Result<{ id: string }>> {
  const m = findModule(ctx.config, moduleKey); if (!m) return fail('Module not found.');
  const v = validateRecord(m.object, input); if (!v.ok) return v; // friendly errors first; the database validates again
  const { data, error } = await ctx.db.rpc('record_create', { p_org: ctx.organizationId, p_object: m.object.key, p_data: v.value });
  return error ? dbError(error) : { ok: true, value: { id: data as string } };
}

export async function updateRecord(ctx: RecordsContext, moduleKey: string, id: string, input: Record<string, unknown>): Promise<Result<null>> {
  const m = findModule(ctx.config, moduleKey); if (!m) return fail('Module not found.');
  const cur = await getRecord(ctx, moduleKey, id); if (!cur.ok) return cur;
  const v = validateRecord(m.object, input, cur.value.data); if (!v.ok) return v;
  const { error } = await ctx.db.rpc('record_update', { p_org: ctx.organizationId, p_record: id, p_data: input });
  return error ? dbError(error) : { ok: true, value: null };
}

export const canEditRecord = (ctx: Pick<RecordsContext, 'role' | 'userId'>, r: Pick<RecordRow, 'createdBy'>) => ['owner', 'admin', 'manager'].includes(ctx.role) || r.createdBy === ctx.userId;
