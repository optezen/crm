'use client';
import { useActionState } from 'react';
import { saveProfileAction, savePrefsAction, setReadAction, type PrefState } from '../../app/(app)/notifications/actions';
import type { Prefs } from '../../lib/ux/service';

export function PrefsForm({ prefs }: { prefs: Prefs }) {
  const [state, run, pending] = useActionState<PrefState, FormData>(savePrefsAction, null);
  const row = (name: keyof Prefs, label: string, hint: string) => <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}><input type="checkbox" name={name} defaultChecked={prefs[name]} style={{ marginTop: 5 }} /><span><strong>{label}</strong><br /><span className="muted" style={{ fontSize: 13 }}>{hint}</span></span></label>;
  return <form action={run} className="stack" style={{ gap: 12 }}>
    {row('task_assigned', 'A follow-up is assigned to me', 'When someone else gives you a task.')}{row('lead_assigned', 'A lead is assigned to me', 'When someone else (or an automation) assigns you a lead.')}{row('task_overdue', 'My follow-ups are overdue', 'Once a day per overdue task, when you open Optizen.')}{row('automation', 'Messages from automations', 'Notifications your workspace automations send you.')}
    <p className="muted" style={{ margin: 0, fontSize: 13 }}>These control in-app notifications only. Optizen does not send email, push or WhatsApp notifications from this screen.</p>
    <div className="row"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save preferences'}</button>{state?.error && <span className="err" role="alert">{state.error}</span>}{state?.ok && <span className="ok" role="status">{state.ok}</span>}</div></form>;
}
export function ProfileForm({ name, email }: { name: string; email: string }) {
  const [state, run, pending] = useActionState<PrefState, FormData>(saveProfileAction, null);
  return <form action={run} className="stack" style={{ gap: 12 }}><div className="field"><label htmlFor="pn">Your name</label><input id="pn" name="name" className="input" defaultValue={name} maxLength={80} autoComplete="name" /><span className="hint">Shown to your team instead of your email. Signed in as {email}.</span></div>
    <div className="row"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save name'}</button>{state?.error && <span className="err" role="alert">{state.error}</span>}{state?.ok && <span className="ok" role="status">{state.ok}</span>}</div></form>;
}
export function ReadToggle({ id, read }: { id: string; read: boolean }) {
  return <form action={async () => { await setReadAction(id, !read); }} style={{ display: 'inline' }}><button className="btn" style={{ padding: '4px 10px' }}>{read ? 'Mark unread' : 'Mark read'}</button></form>;
}
