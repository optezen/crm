'use server';
import { headers } from 'next/headers';
import { supabaseConfigured, supabaseServer } from '../../lib/supabase/server';

export async function sendLink(_: unknown, form: FormData): Promise<{ message: string; ok: boolean }> {
  const email = String(form.get('email') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: 'Enter a valid email address.' };
  if (!supabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
  const origin = process.env.NEXT_PUBLIC_SITE_URL || (await headers()).get('origin');
  if (!origin) return { ok: false, message: 'Site URL is unknown. Set NEXT_PUBLIC_SITE_URL.' };
  const { error } = await (await supabaseServer()).auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
  return error ? { ok: false, message: error.message } : { ok: true, message: 'Check your email for a sign-in link.' };
}
