'use client';
import { useEffect, useState } from 'react';
/** Hides the sidebar so tables get the whole width. The choice is remembered in this browser. Desktop only (phones already use a menu). */
export function SideToggle() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(localStorage.getItem('side-hidden') === '1'); } catch {} }, []);
  useEffect(() => { document.querySelector('.shell')?.toggleAttribute('data-side-hidden', hidden); try { localStorage.setItem('side-hidden', hidden ? '1' : '0'); } catch {} }, [hidden]);
  return <button type="button" className="btn side-toggle" onClick={() => setHidden(h => !h)} aria-pressed={hidden} aria-label={hidden ? 'Show menu' : 'Hide menu'} title={hidden ? 'Show menu' : 'Hide menu'}>☰</button>;
}
