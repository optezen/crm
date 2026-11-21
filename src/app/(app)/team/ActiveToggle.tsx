'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setMemberActiveAction } from '../automations/actions';

/** Inactive members stay on the team but are skipped by automatic (round-robin) assignment and cannot receive automation work. */
export function ActiveToggle({ userId, active }: { userId: string; active: boolean }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [err, setErr] = useState<string>();
  return <span className="row" style={{ gap: 8 }}><button type="button" className="btn" disabled={pending} onClick={() => start(async () => { const r = await setMemberActiveAction(userId, !active); if (r.ok) router.refresh(); else setErr(r.error); })}>{active ? 'Deactivate' : 'Activate'}</button>{err && <span className="err" role="alert">{err}</span>}</span>;
}
