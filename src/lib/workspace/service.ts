import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { supabaseConfigured, supabaseServer } from '../supabase/server';
import { resolveMembership } from './resolve';
import { configFromChoice } from './schema';
import type { Membership, Role, SetupChoice, WorkspaceConfig, WorkspaceState } from './types';

export const ORG_COOKIE = 'bos_org';

/** Single entry point for "who is this user and which workspace do they act in". Org id is derived from membership rows, never from the request. */
export const getWorkspaceState = cache(async (): Promise<WorkspaceState> => {
  if (!supabaseConfigured()) return { status: 'unconfigured' };
  const db = await supabaseServer();
  const { data: { user } } = await db.auth.getUser(); // validates the JWT with Supabase, unlike getSession()
  if (!user) return { status: 'unauthenticated' };

  const { data, error } = await db.from('organization_members').select('organization_id, role').eq('user_id', user.id);
  if (error) return { status: 'error', message: error.message };
  const memberships: Membership[] = (data ?? []).map(r => ({ organizationId: r.organization_id, role: r.role as Role }));
  const active = resolveMembership(memberships, (await cookies()).get(ORG_COOKIE)?.value);
  if (!active) return { status: 'no-organization', userId: user.id };

  const { data: cfg, error: cfgErr } = await db.from('workspace_configuration_versions').select('definition')
    .eq('organization_id', active.organizationId).eq('status', 'published').order('revision', { ascending: false }).limit(1).maybeSingle();
  if (cfgErr) return { status: 'error', message: cfgErr.message };
  if (!cfg) return { status: 'error', message: 'This organization has no published workspace configuration.' };
  return { status: 'ready', userId: user.id, organizationId: active.organizationId, role: active.role, config: cfg.definition as WorkspaceConfig };
});

export async function createWorkspace(input: { name: unknown; description: unknown; choice: SetupChoice }): Promise<{ ok: true } | { ok: false; error: string }> {
  // The configuration is rebuilt and validated here from the user's choice; a client-supplied config is never stored as-is.
  const r = configFromChoice(input, input.choice);
  if (!r.ok) return r;
  if (!supabaseConfigured()) return { ok: false, error: 'Supabase is not configured.' };
  const config = r.value;
  const db = await supabaseServer();
  // Security-definer RPC: owner = auth.uid() inside the database; the client never supplies a user or org id.
  const { data, error } = await db.rpc('create_workspace', { p_name: config.businessName, p_description: config.description ?? null, p_preset: config.preset ?? null, p_definition: config });
  // Only errors the SQL function raises deliberately (invalid input / limit) are shown; anything else stays generic.
  if (error) return { ok: false, error: error.code === '22023' || error.code === '54000' ? error.message : 'Could not create the workspace. Please try again.' };
  (await cookies()).set(ORG_COOKIE, String(data), { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' });
  return { ok: true };
}
