import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getWorkspaceState } from '../../lib/workspace/service';
import { canBuild } from '../../lib/workspace/resolve';
import { OPS_MODULES, opsAccess, opsEnabled } from '../../lib/operations/ops';
import { AppShell } from '../../components/ux/AppShell';
import { SetupNotice } from '../../components/SetupNotice';
import { Notice } from '../../components/ui/Notice';
import { signOut } from './actions';
import { AiPanel } from '../../components/AiPanel';
import { speechAvailable } from '../../lib/ai/speech';
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
  const builder = canBuild(s.role);
  const modules = s.config.modules.filter(m => m.status === 'active' && m.key !== 'overview').map(m => ({ label: m.label, href: `/work/${m.key}` }));
  const ops = OPS_MODULES.filter(m => opsEnabled(s.config, m.key) && opsAccess(s.role, m.key)).map(m => ({ label: m.label, href: m.href }));
  const planned = builder ? s.config.modules.filter(m => m.status === 'planned') : [];
  const groups: { title: string; links: { label: string; href: string }[] }[] = [
    { title: 'Work', links: [{ label: 'Home', href: '/work' }, ...modules, { label: 'Follow-ups', href: '/tasks' }, ...ops] },
    { title: 'Insights', links: [{ label: 'Dashboards', href: '/dashboards' }, { label: 'Reports', href: '/reports' }] },
    ...(builder ? [{ title: 'Set up', links: [{ label: 'Builder', href: '/builder/home' }, { label: 'Team', href: '/team' }] }] : []),
    { title: 'You', links: [{ label: `Notifications${unread > 0 ? ` (${unread})` : ''}`, href: '/notifications' }, { label: 'Account', href: '/account' }] },
  ];
  const items = [...groups.flatMap(g => g.links.map(l => ({ label: l.label.replace(/ \(\d+\)$/, ''), href: l.href }))), { label: 'Search everything', href: '/search' }, ...(builder ? [{ label: 'Workflows', href: '/automations' }, { label: 'Forms', href: '/builder/forms' }, { label: 'Pipeline', href: '/builder/pipeline' }, { label: 'Connections', href: '/builder/connections' }] : [])];
  return <AppShell businessName={s.config.businessName} groups={groups} planned={planned.map(m => m.label)} unread={unread} items={items} signOut={signOut} ai={<AiPanel available={aiAvailable()} role={s.role} voice={speechAvailable()} />}>{children}</AppShell>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
