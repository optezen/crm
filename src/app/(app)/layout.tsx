import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getWorkspaceState } from '../../lib/workspace/service';
import { canBuild } from '../../lib/workspace/resolve';
import { NavLink } from '../../components/ui/NavLink';
import { CommandSearch } from '../../components/ui/CommandSearch';
import { SetupNotice } from '../../components/SetupNotice';
import { Notice } from '../../components/ui/Notice';
import { signOut } from './actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await getWorkspaceState();
  if (s.status === 'unconfigured') return <main className="center"><h1>Optizen</h1><SetupNotice /><p className="muted" style={{ marginTop: 24 }}>You can still <a href="/onboarding">preview onboarding</a>.</p></main>;
  if (s.status === 'unauthenticated') redirect('/login');
  if (s.status === 'no-organization') redirect('/onboarding');
  if (s.status === 'error') return <main className="center"><Notice title="Workspace could not be loaded">{s.message}</Notice></main>;

  const active = s.config.modules.filter(m => m.status === 'active');
  const planned = s.config.modules.filter(m => m.status === 'planned');
  const items = [...active.map(m => ({ label: m.label, href: m.key === 'overview' ? '/work' : `/work/${m.key}` })), ...(canBuild(s.role) ? [{ label: 'Builder', href: '/builder' }, { label: 'Team', href: '/team' }] : [])];
  return <div className="shell">
    <aside className="side"><div className="brand">{s.config.businessName}<small>Optizen</small></div>
      <nav className="nav" aria-label="Workspace">
        <span className="eyebrow">Work</span>
        {active.map(m => <NavLink key={m.key} href={m.key === 'overview' ? '/work' : `/work/${m.key}`}>{m.label}</NavLink>)}
        {planned.length > 0 && <span className="eyebrow">Coming later</span>}
        {planned.map(m => <span key={m.key} className="planned">{m.label}<span className="tag">Planned</span></span>)}
        {canBuild(s.role) && <><span className="eyebrow">Configure</span><NavLink href="/builder">Builder</NavLink><NavLink href="/team">Team</NavLink></>}
      </nav>
      <form action={signOut} style={{ marginTop: 'auto' }}><button className="btn" style={{ width: '100%' }}>Sign out</button></form></aside>
    <main className="main"><div className="row" style={{ justifyContent: 'flex-end', marginBottom: 16 }}><CommandSearch items={items} /></div>{children}</main>
  </div>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
