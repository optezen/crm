'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from '../../lib/supabase/server';
import { ORG_COOKIE } from '../../lib/workspace/service';

export async function signOut() {
  await (await supabaseServer()).auth.signOut(); // revokes the session server-side and clears auth cookies
  (await cookies()).delete(ORG_COOKIE);
  redirect('/login');
}
