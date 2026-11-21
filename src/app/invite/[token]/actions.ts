'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from '../../../lib/supabase/server';
import { ORG_COOKIE } from '../../../lib/workspace/service';

export async function acceptInviteAction(token: string): Promise<{ error: string }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: 'This invitation link is not valid.' };
  const { data, error } = await (await supabaseServer()).rpc('invite_accept', { p_token: token });
  if (error) return { error: ['22023', '42501'].includes(error.code ?? '') ? error.message : 'Something went wrong. Please try again.' };
  (await cookies()).set(ORG_COOKIE, String(data), { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' });
  redirect('/work');
}
