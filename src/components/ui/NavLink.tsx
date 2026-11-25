'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// 24x24 outline paths, one per destination (matched by URL, so custom modules and optional modules get a sensible icon too).
const I: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  leads: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  tasks: 'M9 11l2 2 4-4M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  report: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
  tune: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  team: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20a7 7 0 0114 0M17 4.5a3.5 3.5 0 010 6.5M22 20a6 6 0 00-4-5.6',
  bell: 'M6 9a6 6 0 0112 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 004 0',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
};
const iconFor = (h: string) => h === '/work' ? 'home' : h.startsWith('/work/leads') ? 'leads' : h.startsWith('/tasks') ? 'tasks' : h.startsWith('/dashboards') ? 'chart' : h.startsWith('/reports') ? 'report'
  : h.startsWith('/builder') ? 'tune' : h.startsWith('/automations') ? 'bolt' : h.startsWith('/team') ? 'team' : h.startsWith('/notifications') ? 'bell' : h.startsWith('/account') ? 'user'
  : h.startsWith('/work/appointments') ? 'calendar' : h.startsWith('/work/inventory') ? 'box' : h.startsWith('/work/billing') ? 'receipt' : 'grid';

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const current = href === '/work' ? path === href : path === href || path.startsWith(href + '/');
  return <Link href={href} aria-current={current ? 'page' : undefined}><svg className="ni" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={I[iconFor(href)]} /></svg><span className="nl">{children}</span></Link>;
}
