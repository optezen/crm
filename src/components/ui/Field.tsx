import type { InputHTMLAttributes } from 'react';
export function Field({ label, hint, error, id, ...rest }: { label: string; hint?: string; error?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return <div className="field"><label htmlFor={id}>{label}</label>
    <input id={id} className="input" aria-invalid={!!error} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} {...rest} />
    {hint && !error && <span id={`${id}-hint`} className="hint">{hint}</span>}
    {error && <span id={`${id}-err`} className="err" role="alert">{error}</span>}</div>;
}
