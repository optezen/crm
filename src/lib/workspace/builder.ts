// Builder lifecycle: load/save a draft, publish it as the next immutable revision, discard it. Owners/admins only (re-checked by the database).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Result, WorkspaceConfig } from './types.ts';
import { validateConfig } from './schema.ts';

type Err = { code?: string; message: string };
const dbError = (e: Err): { ok: false; error: string } => ({ ok: false, error: ['22023', '23505', '42501'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.' });
export type VersionRow = { revision: number; status: 'draft' | 'published' | 'archived'; createdAt: string };

export async function loadDraft(db: SupabaseClient, organizationId: string): Promise<Result<WorkspaceConfig | null>> {
  const { data, error } = await db.from('workspace_configuration_versions').select('definition').eq('organization_id', organizationId).eq('status', 'draft').maybeSingle();
  if (error) return dbError(error);
  return { ok: true, value: (data?.definition as WorkspaceConfig | undefined) ?? null };
}
export async function listVersions(db: SupabaseClient, organizationId: string): Promise<Result<VersionRow[]>> {
  const { data, error } = await db.from('workspace_configuration_versions').select('revision, status, created_at').eq('organization_id', organizationId).order('revision', { ascending: false }).limit(15);
  if (error) return dbError(error);
  return { ok: true, value: data.map(r => ({ revision: r.revision, status: r.status, createdAt: r.created_at })) };
}
export async function saveDraft(db: SupabaseClient, organizationId: string, raw: unknown): Promise<Result<{ revision: number }>> {
  const v = validateConfig(raw);
  if (!v.ok) return { ok: false, error: v.errors[0]! };
  const { data, error } = await db.rpc('save_workspace_draft', { p_org: organizationId, p_definition: v.value });
  return error ? dbError(error) : { ok: true, value: { revision: data as number } };
}
export async function publishDraft(db: SupabaseClient, organizationId: string): Promise<Result<{ revision: number }>> {
  const { data, error } = await db.rpc('publish_workspace_config', { p_org: organizationId });
  return error ? dbError(error) : { ok: true, value: { revision: data as number } };
}
export async function discardDraft(db: SupabaseClient, organizationId: string): Promise<Result<null>> {
  const { error } = await db.rpc('discard_workspace_draft', { p_org: organizationId });
  return error ? dbError(error) : { ok: true, value: null };
}
export async function restoreRevision(db: SupabaseClient, organizationId: string, revision: unknown): Promise<Result<{ revision: number }>> {
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return { ok: false, error: 'That version does not exist.' };
  const { data, error } = await db.rpc('restore_workspace_revision', { p_org: organizationId, p_revision: revision });
  return error ? dbError(error) : { ok: true, value: { revision: data as number } };
}
