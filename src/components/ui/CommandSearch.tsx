'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from './Dialog';
export type CommandItem = { label: string; href: string };
export function CommandSearch({ items }: { items: CommandItem[] }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const router = useRouter();
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setOpen(o => !o); } }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  const hits = items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()));
  const go = (href: string) => { setOpen(false); setQ(''); router.push(href); };
  return <>
    <button className="btn" onClick={() => setOpen(true)} aria-keyshortcuts="Control+K Meta+K">Search <kbd className="muted">⌘K</kbd></button>
    <Dialog open={open} onClose={() => setOpen(false)} label="Search workspace">
      <label className="sr-only" htmlFor="cmd-q">Search</label>
      <input id="cmd-q" className="input" autoFocus placeholder="Go to…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && hits[0]) go(hits[0].href); }} />
      <ul className="results">{hits.map(h => <li key={h.href}><a href={h.href} onClick={e => { e.preventDefault(); go(h.href); }}>{h.label}</a></li>)}</ul>
      {hits.length === 0 && <p className="muted">No matches.</p>}
    </Dialog></>;
}
