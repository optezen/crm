'use client';
import { useEffect, useRef, type ReactNode } from 'react';
/** Native <dialog>: focus trap, Esc and inert background come from the platform. */
export function Dialog({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && open !== d.open) open ? d.showModal() : d.close(); }, [open]);
  return <dialog ref={ref} aria-label={label} onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="dlg">{children}</div></dialog>;
}
