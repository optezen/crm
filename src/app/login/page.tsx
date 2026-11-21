import { supabaseConfigured } from '../../lib/supabase/server';
import { SetupNotice } from '../../components/SetupNotice';
import { LoginForm } from './LoginForm';
import { safeNext } from '../../lib/ux/nav';
export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return <main className="center stack"><div><h1>Sign in to Optizen</h1><p className="muted">{next?.startsWith('/invite/') ? 'Sign in with the email address you were invited at to join your team.' : 'Use your work email to continue.'}</p></div>{supabaseConfigured() ? <LoginForm next={next} /> : <SetupNotice />}</main>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
