'use client';
import { useEffect, useState } from 'react';
/** Hides the sidebar so tables get the whole width. The choice is remembered in this browser. Desktop only (phones already use a menu). */
export function SideToggle() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(localStorage.getItem('side-hidden') === '1'); } catch {} }, []);
  useEffect(() => { document.querySelector('.shell')?.toggleAttribute('data-side-hidden', hidden); try { localStorage.setItem('side-hidden', hidden ? '1' : '0'); } catch {} }, [hidden]);
  return <button type="button" className="btn side-toggle" onClick={() => setHidden(h => !h)} aria-pressed={hidden} aria-label={hidden ? 'Show menu' : 'Hide menu'} title={hidden ? 'Show menu' : 'Hide menu'}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg></button>;
}
