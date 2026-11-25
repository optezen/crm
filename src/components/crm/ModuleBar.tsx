import Link from 'next/link';
import type { ReactNode } from 'react';

/** Module header shared by the lead list and the board: name, record count, List/Kanban, and the page actions. */
export function ModuleBar({ title, meta, view, actions }: { title: string; meta?: string; view?: 'list' | 'board'; actions?: ReactNode }) {
  return <header className="zmod">
    <div className="zmod-id"><h1>{title}</h1>{meta && <p>{meta}</p>}</div>
    {view && <div className="zswitch" role="group" aria-label="Lead view">
      <Link href="/work/leads" aria-current={view === 'list' ? 'page' : undefined}>List</Link>
      <Link href="/work/leads/board" aria-current={view === 'board' ? 'page' : undefined}>Kanban</Link>
    </div>}
    {actions && <div className="zmod-actions">{actions}</div>}
  </header>;
}
