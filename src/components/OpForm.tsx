'use client';
import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { callOps, type OpsResult } from '../app/(app)/work/ops-actions';

export type OpField = { name: string; label: string; type?: 'text' | 'number' | 'date' | 'datetime' | 'datetime_local' | 'select' | 'checkbox' | 'textarea'; options?: [string, string][]; required?: boolean; placeholder?: string; step?: string; defaultValue?: string; wide?: boolean };

/** One generic form for operations functions: values are sent as typed arguments to an allow-listed database function. Totals are never computed here. */
export function OpForm({ fn, fields, fixed, submit, message, onDone, redirect, compact }: { fn: string; fields: OpField[]; fixed?: Record<string, unknown>; submit: string; message?: string; onDone?: (r: Extract<OpsResult, { ok: true }>) => void; redirect?: (data: unknown) => string; compact?: boolean }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [vals, setVals] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map(f => [f.name, f.type === 'checkbox' ? false : f.defaultValue ?? ''])));
  const go = () => start(async () => {
    const args: Record<string, unknown> = { ...(fixed ?? {}) };
    for (const f of fields) { const v = vals[f.name]; args[f.name] = f.type === 'checkbox' ? v === true : v === '' ? null : f.type === 'number' ? String(v) : f.type === 'datetime' ? new Date(String(v)).toISOString() : v; } // datetime_local is sent as typed (no browser time zone), so the database applies the ORGANIZATION time zone
    const r = await callOps(fn, args, message); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error });
    if (r.ok) { if (redirect) router.push(redirect(r.data)); else router.refresh(); onDone?.(r); }
  });
  return <form className={compact ? 'inline' : 'stack'} style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); go(); }}>
    <div className={compact ? 'inline' : 'form-grid'}>{fields.map(f => <div className={`field${f.wide ? ' wide' : ''}`} key={f.name}><label htmlFor={`${fn}-${f.name}`}>{f.label}</label>
      {f.type === 'select' ? <select id={`${fn}-${f.name}`} className="input" required={f.required} value={String(vals[f.name])} onChange={e => setVals({ ...vals, [f.name]: e.target.value })}><option value="">{f.required ? 'Choose…' : '—'}</option>{f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        : f.type === 'textarea' ? <textarea id={`${fn}-${f.name}`} className="input" required={f.required} placeholder={f.placeholder} value={String(vals[f.name])} onChange={e => setVals({ ...vals, [f.name]: e.target.value })} />
        : f.type === 'checkbox' ? <input id={`${fn}-${f.name}`} type="checkbox" checked={vals[f.name] === true} onChange={e => setVals({ ...vals, [f.name]: e.target.checked })} />
        : <input id={`${fn}-${f.name}`} className="input" type={f.type === 'datetime' || f.type === 'datetime_local' ? 'datetime-local' : f.type === 'number' ? 'number' : f.type ?? 'text'} step={f.step ?? (f.type === 'number' ? 'any' : undefined)} required={f.required} placeholder={f.placeholder} value={String(vals[f.name])} onChange={e => setVals({ ...vals, [f.name]: e.target.value })} />}</div>)}</div>
    <div className="row"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : submit}</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</div>
  </form>;
}

/** A single-click operation (book this slot, cancel, issue...). */
export function OpButton({ fn, args, label, confirmText, message, redirectTo, kind }: { fn: string; args: Record<string, unknown>; label: ReactNode; confirmText?: string; message?: string; redirectTo?: (data: unknown) => string; kind?: 'primary' }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  return <span className="row" style={{ gap: 8 }}><button type="button" className={`btn${kind ? ' primary' : ''}`} disabled={pending} onClick={() => { if (confirmText && !confirm(confirmText)) return; start(async () => { const r = await callOps(fn, args, message); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { if (redirectTo) router.push(redirectTo(r.data)); else router.refresh(); } }); }}>{pending ? 'Working…' : label}</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</span>;
}
