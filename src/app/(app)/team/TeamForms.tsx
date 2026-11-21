'use client';
import { useActionState, useState } from 'react';
import { inviteAction, revokeInviteAction, updateAccessAction, type InviteState } from './invite-actions';

export type RoleOption = { value: string; label: string };
export type BranchOption = { id: string; name: string };

export function InviteForm({ roles, branches }: { roles: RoleOption[]; branches: BranchOption[] }) {
  const [state, run, pending] = useActionState<InviteState, FormData>(inviteAction, null); const [copied, setCopied] = useState(false);
  return <form action={run} className="stack">
    <div className="form-grid">
      <div className="field"><label htmlFor="inv-email">Their email address</label><input id="inv-email" name="email" type="email" className="input" required autoComplete="off" inputMode="email" /></div>
      <div className="field"><label htmlFor="inv-role">Role</label><select id="inv-role" name="role" className="input" defaultValue="employee">{roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
      <div className="field"><label htmlFor="inv-days">Link works for</label><select id="inv-days" name="days" className="input" defaultValue="7">{[1, 3, 7, 14, 30].map(d => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}</select></div>
    </div>
    {branches.length > 0 && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="muted" style={{ fontSize: 13 }}>Branch access (optional)</legend><div className="row">{branches.map(b => <label key={b.id} className="row" style={{ gap: 6 }}><input type="checkbox" name="branch" value={b.id} /> {b.name}</label>)}</div></fieldset>}
    {state?.error && <p className="err" role="alert">{state.error}</p>}
    {state?.link && <div className="notice" role="status"><strong>{state.ok}</strong>
      <div className="row" style={{ marginTop: 8 }}><input className="input" readOnly value={state.link} aria-label="Invitation link" onFocus={e => e.currentTarget.select()} style={{ flex: 1, minWidth: 200 }} />
        <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(state.link!); setCopied(true); } catch { /* the link can still be selected and copied by hand */ } }}>{copied ? 'Copied' : 'Copy link'}</button></div>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>Optizen does not send email. This link is shown only now; if you lose it, revoke it and invite again.</p></div>}
    <div><button className="btn primary" disabled={pending}>{pending ? 'Creating…' : 'Create invitation link'}</button></div>
  </form>;
}
export function RevokeButton({ id }: { id: string }) {
  const [msg, setMsg] = useState<string>(); const [busy, setBusy] = useState(false);
  return <><button type="button" className="btn" disabled={busy} onClick={async () => { if (!confirm('Revoke this invitation? The link will stop working.')) return; setBusy(true); const r = await revokeInviteAction(id); setBusy(false); if (!r.ok) setMsg(r.error); }}>Revoke</button>{msg && <span className="err" role="alert">{msg}</span>}</>;
}
export function AccessForm({ userId, email, role, customRoleId, roles, branches, mine }: { userId: string; email: string; role: string; customRoleId: string | null; roles: RoleOption[]; branches: BranchOption[]; mine: string[] }) {
  const [state, run, pending] = useActionState<InviteState, FormData>(updateAccessAction, null);
  return <form action={run} className="stack" style={{ gap: 8 }}><input type="hidden" name="userId" value={userId} />
    <div className="inline">
      <div className="field"><label htmlFor={`r-${userId}`}>Role for {email}</label><select id={`r-${userId}`} name="role" className="input" defaultValue={customRoleId ? `custom:${customRoleId}` : role}>{roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
      {branches.length > 0 && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="muted" style={{ fontSize: 12 }}>Branches</legend><div className="row">{branches.map(b => <label key={b.id} className="row" style={{ gap: 6 }}><input type="checkbox" name="branch" value={b.id} defaultChecked={mine.includes(b.id)} /> {b.name}</label>)}</div></fieldset>}
      <button className="btn" disabled={pending}>{pending ? 'Saving…' : 'Save access'}</button></div>
    {state?.error && <p className="err" role="alert">{state.error}</p>}{state?.ok && <p className="ok" role="status">{state.ok}</p>}</form>;
}
