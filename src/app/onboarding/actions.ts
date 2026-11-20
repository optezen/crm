'use server';
import { redirect } from 'next/navigation';
import { createWorkspace, getWorkspaceState } from '../../lib/workspace/service';
import { aiConfigured, draftWorkspace } from '../../lib/workspace/ai';
import { validateOnboarding } from '../../lib/workspace/schema';
import type { Result, SetupChoice, WorkspaceConfig } from '../../lib/workspace/types';

export async function createWorkspaceAction(name: string, description: string, choice: SetupChoice): Promise<{ error: string }> {
  const r = await createWorkspace({ name, description, choice }); // re-validated and rebuilt server-side
  if (!r.ok) return { error: r.error };
  redirect('/work');
}

/** AI-assisted draft. Requires a signed-in user (so the API key cannot be used anonymously) and a configured key. Returns a DRAFT only. */
export async function aiDraftAction(name: string, description: string): Promise<Result<WorkspaceConfig>> {
  const s = await getWorkspaceState();
  if (s.status !== 'no-organization' && s.status !== 'ready') return { ok: false, error: 'Sign in to use AI drafting.' };
  if (!aiConfigured()) return { ok: false, error: 'AI drafting is not configured on this deployment.' };
  const v = validateOnboarding({ name, description });
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0]! };
  return draftWorkspace(v.value, { apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.OPTIZEN_AI_MODEL });
}
