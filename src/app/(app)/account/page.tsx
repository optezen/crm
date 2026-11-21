import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { memberNames, notificationPrefs } from '../../../lib/ux/service';
import { Card } from '../../../components/ui/Card';
import { PrefsForm, ProfileForm } from '../../../components/ux/PrefsForm';
import { signOut } from '../actions';

export default async function Account() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null; const db = await supabaseServer();
  const [{ data: { user } }, names, prefs] = await Promise.all([db.auth.getUser(), memberNames(db, s.organizationId), notificationPrefs(db, s.organizationId)]);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">You</span><h1>Your account</h1><p className="muted">You are {s.role === 'owner' ? 'the owner' : `${s.role === 'admin' ? 'an' : 'a'} ${s.role}`} of {s.config.businessName}.</p></div></div>
    <Card title="Profile"><ProfileForm name={names[s.userId] ?? ''} email={user?.email ?? ''} /></Card>
    <Card title="Notifications" description="Choose which in-app notifications you receive."><PrefsForm prefs={prefs} /></Card>
    <Card title="Session"><form action={signOut}><button className="btn">Sign out</button></form></Card>
  </div>;
}
