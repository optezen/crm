'use server';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { supabaseServer } from '../../../lib/supabase/server';

const UUID = /^[0-9a-f-]{36}$/i;
export type InviteState = { error?: string; ok?: string; link?: string } | null;
async function ctx() { const s = await getWorkspaceState(); if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' } as const; if (!canBuild(s.role)) return { error: 'Only owners and admins can manage the team.' } as const; return { org: s.organizationId, db: await supabaseServer() } as const; }
const map = (e: { code?: string; message: string }) => (['22023', '42501', 'P0002', '23505'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.');

/** Creates an invitation and returns the LINK once. Optizen does not send email: the inviter shares the link, and it only works for the invited email address. */
export async function inviteAction(_: InviteState, f: FormData): Promise<InviteState> {
  const c = await ctx(); if ('error' in c) return { error: c.error };
  const role = String(f.get('role') ?? 'employee'); const roleKey = role.startsWith('custom:') ? null : role; const custom = role.startsWith('custom:') ? role.slice(7) : null;
  if (custom !== null && !UUID.test(custom)) return { error: 'Choose a valid role.' };
  const branches = f.getAll('branch').map(String).filter(b => UUID.test(b)); const days = Number(f.get('days') ?? 7);
  const r = await c.db.rpc('invite_create', { p_org: c.org, p_email: String(f.get('email') ?? ''), p_role: roleKey ?? 'employee', p_custom_role: custom, p_branches: branches, p_days: Number.isInteger(days) ? days : 7 });
  if (r.error) return { error: map(r.error) };
  const origin = process.env.NEXT_PUBLIC_SITE_URL || (await headers()).get('origin') || ''; const t = r.data as { token: string };
  revalidatePath('/team'); return { ok: 'Invitation created. Share this link with them; it works only for that email address.', link: `${origin}/invite/${t.token}` };
}
export async function revokeInviteAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx(); if ('error' in c || !UUID.test(id)) return { ok: false, error: 'error' in c ? c.error : 'Invalid invitation.' };
  const r = await c.db.rpc('invite_revoke', { p_org: c.org, p_id: id }); revalidatePath('/team'); return r.error ? { ok: false, error: map(r.error) } : { ok: true };
}
/** Role, custom role and branch access in one step. */
export async function updateAccessAction(_: InviteState, f: FormData): Promise<InviteState> {
  const c = await ctx(); if ('error' in c) return { error: c.error };
  const user = String(f.get('userId') ?? ''); if (!UUID.test(user)) return { error: 'Team member not found.' };
  const role = String(f.get('role') ?? ''); const custom = role.startsWith('custom:') ? role.slice(7) : null; if (custom !== null && !UUID.test(custom)) return { error: 'Choose a valid role.' };
  const r = await c.db.rpc('member_update_access', { p_org: c.org, p_user: user, p_role: custom ? 'employee' : role, p_custom_role: custom, p_branches: f.getAll('branch').map(String).filter(b => UUID.test(b)) });
  if (r.error) return { error: map(r.error) }; revalidatePath('/team'); return { ok: 'Access updated.' };
}
