'use client';
import { useState, useTransition } from 'react';
import { bulkLeadsAction } from '../../app/(app)/work/leads/actions';

/** The pipeline as one row: the current stage is filled, earlier ones are ticked, any stage is one click. */
export function StageStepper({ leadId, stages, current }: { leadId: string; stages: string[]; current: string }) {
  const [pending, start] = useTransition(); const [err, setErr] = useState<string | null>(null);
  const list = [...new Set([...stages, current])]; const at = list.indexOf(current);
  return <div><ol className="stepper" aria-label="Pipeline stage">{list.map((s, i) => <li key={s}>
    <button type="button" disabled={pending} aria-current={s === current ? 'step' : undefined} className={i < at ? 'past' : i === at ? 'now' : ''} onClick={() => { if (s !== current) start(async () => { const r = await bulkLeadsAction([leadId], { stage: s }); setErr(r?.error ?? null); }); }}>{i < at ? '✓ ' : ''}{s}</button></li>)}</ol>
    {err && <p className="err" role="alert">{err}</p>}</div>;
}
