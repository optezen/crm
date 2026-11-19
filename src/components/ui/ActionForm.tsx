'use client';
import { useActionState, useEffect, useRef, useTransition, type ReactNode } from 'react';

export type FormState = { error?: string; ok?: string } | null;
/** Submits via a server action without the React 19 auto-reset, so input survives a validation error. Clears itself only on success when asked. */
export function ActionForm({ action, submit, children, className, resetOnSuccess }: { action: (prev: FormState, data: FormData) => Promise<FormState>; submit: string; children: ReactNode; className?: string; resetOnSuccess?: boolean }) {
  const [state, run] = useActionState(action, null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok && resetOnSuccess) ref.current?.reset(); }, [state, resetOnSuccess]);
  return <form ref={ref} className={className ?? 'stack'} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); start(() => run(data)); }}>
    {children}
    {state?.error && <p className="err" role="alert">{state.error}</p>}
    {state?.ok && <p className="ok" role="status">{state.ok}</p>}
    <div><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : submit}</button></div>
  </form>;
}
