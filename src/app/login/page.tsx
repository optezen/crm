import { supabaseConfigured } from '../../lib/supabase/server';
import { SetupNotice } from '../../components/SetupNotice';
import { LoginForm } from './LoginForm';
export default function Login() {
  return <main className="center stack"><div><h1>Sign in</h1><p className="muted">Use your work email to continue.</p></div>{supabaseConfigured() ? <LoginForm /> : <SetupNotice />}</main>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
