'use client';
import { useState } from 'react';
/** Copies a value to the clipboard and says so. Falls back to a message when the browser blocks clipboard access (the value stays selectable). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return <>
    <button type="button" className="btn" aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setState('ok'); } catch { setState('fail'); } setTimeout(() => setState('idle'), 3000); }}>{state === 'ok' ? 'Copied' : 'Copy'}</button>
    <span role="status" className="sr-only">{state === 'ok' ? `${label} copied` : state === 'fail' ? `Could not copy ${label}; select it and copy manually` : ''}</span>
    {state === 'fail' && <span className="err" aria-hidden="true">Could not copy. Select the text instead.</span>}
  </>;
}
