import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getWorkspaceState } from '../../lib/workspace/service';
import { canBuild } from '../../lib/workspace/resolve';
import { OPS_MODULES, opsAccess, opsEnabled } from '../../lib/operations/ops';
import { NavLink } from '../../components/ui/NavLink';
import { CommandSearch } from '../../components/ui/CommandSearch';
import { SetupNotice } from '../../components/SetupNotice';
import { Notice } from '../../components/ui/Notice';
import { signOut } from './actions';
import { AiPanel } from '../../components/AiPanel';
import { aiAvailable } from '../../lib/ai/anthropic';
import { unreadCount } from '../../lib/automation/service';
import { supabaseServer } from '../../lib/supabase/server';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await getWorkspaceState();
  if (s.status === 'unconfigured') return <main className="center"><h1>Optizen</h1><SetupNotice /><p className="muted" style={{ marginTop: 24 }}>You can still <a href="/onboarding">preview onboarding</a>.</p></main>;
  if (s.status === 'unauthenticated') redirect('/login');
  if (s.status === 'no-organization') redirect('/onboarding');
  if (s.status === 'error') return <main className="center"><Notice title="Workspace could not be loaded">{s.message}</Notice></main>;

  const unread = await unreadCount(await supabaseServer(), s.organizationId);
  const active = s.config.modules.filter(m => m.status === 'active');
  const ops = OPS_MODULES.filter(m => opsEnabled(s.config, m.key) && opsAccess(s.role, m.key));
  const planned = s.config.modules.filter(m => m.status === 'planned');
  const analyticsNav = [{ label: 'Dashboards', href: '/dashboards' }, { label: 'Reports', href: '/reports' }];
  const items = [...analyticsNav, ...active.map(m => ({ label: m.label, href: m.key === 'overview' ? '/work' : `/work/${m.key}` })), ...ops.map(m => ({ label: m.label, href: m.href })), { label: 'Notifications', href: '/notifications' }, ...(canBuild(s.role) ? [{ label: 'Builder', href: '/builder' }, { label: 'Automations', href: '/automations' }, { label: 'Connections', href: '/builder/connections' }, { label: 'Team', href: '/team' }] : [])];
  return <div className="shell">
    <aside className="side"><div className="brand">{s.config.businessName}<small>Optizen</small></div>
      <nav className="nav" aria-label="Workspace">
        <span className="eyebrow">Work</span>
        {active.map(m => <NavLink key={m.key} href={m.key === 'overview' ? '/work' : `/work/${m.key}`}>{m.label}</NavLink>)}
        {ops.map(m => <NavLink key={m.key} href={m.href}>{m.label}</NavLink>)}
        <span className="eyebrow">Insights</span><NavLink href="/dashboards">Dashboards</NavLink><NavLink href="/reports">Reports</NavLink>
        {planned.length > 0 && <span className="eyebrow">Coming later</span>}
        {planned.map(m => <span key={m.key} className="planned">{m.label}<span className="tag">Planned</span></span>)}
        {canBuild(s.role) && <><span className="eyebrow">Configure</span><NavLink href="/builder">Builder</NavLink><NavLink href="/automations">Automations</NavLink><NavLink href="/builder/connections">Connections</NavLink><NavLink href="/team">Team</NavLink></>}
        <span className="eyebrow">You</span><NavLink href="/notifications">Notifications{unread > 0 ? ` (${unread})` : ''}</NavLink>
      </nav>
      <form action={signOut} style={{ marginTop: 'auto' }}><button className="btn" style={{ width: '100%' }}>Sign out</button></form></aside>
    <main className="main"><div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginBottom: 16 }}><AiPanel available={aiAvailable()} role={s.role} /><CommandSearch items={items} /></div>{children}</main>
  </div>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
