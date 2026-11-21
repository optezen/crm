'use client';
import { useState, useTransition } from 'react';
import { acceptInviteAction } from './actions';
export function Accept({ token, org, role }: { token: string; org: string; role: string }) {
  const [err, setErr] = useState<string>(); const [pending, start] = useTransition();
  return <div className="stack"><p>You have been invited to join <strong>{org}</strong> as {role === 'admin' ? 'an' : 'a'} <strong>{role}</strong>.</p>
    {err && <p className="err" role="alert">{err}</p>}
    <div><button className="btn primary" disabled={pending} onClick={() => start(async () => { const r = await acceptInviteAction(token); if (r?.error) setErr(r.error); })}>{pending ? 'Joining…' : `Join ${org}`}</button></div></div>;
}
