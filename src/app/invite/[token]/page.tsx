import Link from 'next/link';
import { supabaseConfigured, supabaseServer } from '../../../lib/supabase/server';
import { SetupNotice } from '../../../components/SetupNotice';
import { Notice } from '../../../components/ui/Notice';
import { signOut } from '../../(app)/actions';
import { Accept } from './Accept';

export const dynamic = 'force-dynamic';
/** Accepting an invitation. The link only works for the signed-in account whose email matches the invitation; everything else is explained without revealing who else is on the team. */
export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!supabaseConfigured()) return <main className="center"><SetupNotice /></main>;
  if (!/^[0-9a-f]{64}$/.test(token)) return <main className="center"><Notice title="This invitation link is not valid">Ask the person who invited you for a new link.</Notice></main>;
  const db = await supabaseServer(); const { data: { user } } = await db.auth.getUser();
  if (!user) return <main className="center stack"><div><h1>You have been invited to Optizen</h1><p className="muted">Sign in with the email address the invitation was sent to. We will bring you back here.</p></div><Link className="btn primary" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Continue to sign in</Link></main>;
  const { data } = await db.rpc('invite_preview', { p_token: token }); const p = data as { state: string; organization?: string; role?: string } | null;
  const msg: Record<string, [string, string]> = { invalid: ['This invitation link is not valid', 'Ask the person who invited you for a new link.'], expired: ['This invitation has expired', 'Ask for a new invitation.'], revoked: ['This invitation was withdrawn', 'Ask for a new invitation if you still need access.'], accepted: ['This invitation was already used', 'If that was you, go to your workspace.'] };
  return <main className="center stack">
    {p?.state === 'ready' && <><h1>Join {p.organization}</h1><Accept token={token} org={p.organization ?? ''} role={p.role ?? 'employee'} /></>}
    {p?.state === 'wrong_account' && <Notice title="This invitation is for a different email address">You are signed in as {user.email}. Sign out and sign in with the address the invitation was sent to.<form action={signOut} style={{ marginTop: 12 }}><button className="btn">Sign out</button></form></Notice>}
    {(!p || msg[p.state]) && <Notice title={msg[p?.state ?? 'invalid']![0]}>{msg[p?.state ?? 'invalid']![1]} <Link href="/work">Go to your workspace</Link></Notice>}
  </main>;
}
