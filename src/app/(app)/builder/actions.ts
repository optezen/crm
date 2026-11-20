'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { canBuild } from '../../../lib/workspace/resolve';
import { discardDraft, publishDraft, restoreRevision, saveDraft } from '../../../lib/workspace/builder';
import { aiConfigured, draftWorkspace } from '../../../lib/workspace/ai';
import type { Result, WorkspaceConfig } from '../../../lib/workspace/types';

// The organization comes from the signed-in user's membership, never from the request; the database re-checks the role.
async function ctx(): Promise<{ error: string } | { s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>; db: Awaited<ReturnType<typeof supabaseServer>> }> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { error: 'Only owners and admins can edit the workspace configuration.' };
  return { s, db: await supabaseServer() };
}
export type BuilderResult = { ok: true; message: string } | { ok: false; error: string };
const done = (r: Result<unknown>, message: string): BuilderResult => (r.ok ? (revalidatePath('/', 'layout'), { ok: true, message }) : r);

export async function saveDraftAction(definition: unknown): Promise<BuilderResult> {
  const c = await ctx(); if (!('s' in c)) return { ok: false, error: c.error };
  return done(await saveDraft(c.db, c.s.organizationId, definition), 'Draft saved. It is not live until you publish it.');
}
export async function publishAction(): Promise<BuilderResult> {
  const c = await ctx(); if (!('s' in c)) return { ok: false, error: c.error };
  const r = await publishDraft(c.db, c.s.organizationId);
  return done(r, r.ok ? `Published as revision ${r.value.revision}. Navigation and pipelines now use it.` : '');
}
export async function discardAction(): Promise<BuilderResult> {
  const c = await ctx(); if (!('s' in c)) return { ok: false, error: c.error };
  return done(await discardDraft(c.db, c.s.organizationId), 'Draft discarded.');
}
/** Rollback: loads an earlier version into the draft (anything records depend on is kept). Review, then publish like any other change. */
export async function restoreAction(revision: number): Promise<BuilderResult> {
  const c = await ctx(); if (!('s' in c)) return { ok: false, error: c.error };
  return done(await restoreRevision(c.db, c.s.organizationId, revision), `Version ${revision} loaded as a draft. Review the changes, then publish to roll back.`);
}
/** AI draft for the Builder: returns a proposal for the editor only. Saving and publishing remain separate, explicit steps. */
export async function aiDraftBuilderAction(description: string): Promise<Result<WorkspaceConfig>> {
  const c = await ctx(); if (!('s' in c)) return { ok: false, error: c.error };
  if (!aiConfigured()) return { ok: false, error: 'AI drafting is not configured on this deployment.' };
  if (typeof description !== 'string' || description.trim().length < 10 || description.length > 1000) return { ok: false, error: 'Describe your business in 10 to 1000 characters.' };
  return draftWorkspace({ name: c.s.config.businessName, description: description.trim() }, { apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.OPTIZEN_AI_MODEL });
}
