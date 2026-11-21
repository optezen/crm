import Link from 'next/link';
const TABS = [['workflows', '/automations', 'Workflows'], ['forms', '/builder/forms', 'Forms'], ['pipeline', '/builder/pipeline', 'Pipeline'], ['dashboards', '/dashboards', 'Dashboards'], ['modules', '/builder', 'Modules & settings']] as const;
/** Same navigation on every visual editor, so the studio reads as one place. Work Mode is separate (the sidebar). */
export function StudioNav({ current }: { current: (typeof TABS)[number][0] }) {
  return <nav className="studio-nav" aria-label="Builder Studio">{TABS.map(([k, href, label]) => <Link key={k} href={href} aria-current={k === current ? 'page' : undefined}>{label}</Link>)}</nav>;
}
