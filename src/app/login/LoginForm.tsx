'use client';
import { useActionState } from 'react';
import { sendLink } from './actions';
import { Field } from '../../components/ui/Field';
export function LoginForm() {
  const [r, act, pending] = useActionState(sendLink, null);
  return <form action={act} className="stack">
    <Field id="email" name="email" type="email" label="Work email" autoComplete="email" required error={r && !r.ok ? r.message : undefined} />
    <button className="btn primary" disabled={pending}>{pending ? 'Sending…' : 'Email me a sign-in link'}</button>
    {r?.ok && <p role="status">{r.message}</p>}
  </form>;
}
