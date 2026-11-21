import Link from 'next/link';
import { getWorkspaceState } from '../../lib/workspace/service';
const TABS = [['home', '/builder/home', 'Overview'], ['modules', '/builder', 'Modules'], ['forms', '/builder/forms', 'Forms'], ['pipeline', '/builder/pipeline', 'Pipeline'], ['workflows', '/automations', 'Workflows'], ['dashboards', '/dashboards', 'Dashboards'], ['team', '/team', 'Team & roles'], ['connections', '/builder/connections', 'Connections'], ['ai', '/settings/ai', 'AI']] as const;
export type StudioTab = (typeof TABS)[number][0];
/** One navigation for every configuration screen, so Builder reads as a single place. Work Mode is separate (the sidebar). The AI tab is shown to the owner only. */
export async function StudioNav({ current }: { current: StudioTab }) {
  const s = await getWorkspaceState(); const owner = s.status === 'ready' && s.role === 'owner';
  return <nav className="studio-nav" aria-label="Builder sections">{TABS.filter(([k]) => k !== 'ai' || owner).map(([k, href, label]) => <Link key={k} href={href} aria-current={k === current ? 'page' : undefined}>{label}</Link>)}</nav>;
}
