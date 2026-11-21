import type { ReactNode } from 'react';
import { NavLink } from '../ui/NavLink';
import { CommandSearch, type CommandItem } from '../ui/CommandSearch';

export type NavGroup = { title: string; links: { label: string; href: string }[] };
/** The page frame: skip link, sidebar (desktop), menu bar + bottom tabs (phones), search and slots. Presentational only, so the real layout and the browser-test fixtures render the same markup. */
export function AppShell({ businessName, groups, planned, unread, items, signOut, ai, children }: { businessName: string; groups: NavGroup[]; planned: string[]; unread: number; items: CommandItem[]; signOut: () => Promise<void>; ai: ReactNode; children: ReactNode }) {
  const nav = (id: string, label: string) => <nav className="nav" aria-label={label} id={id}>{groups.map(g => <div key={g.title} className="navgroup"><span className="eyebrow">{g.title}</span>{g.links.map(l => <NavLink key={l.href} href={l.href}>{l.label}</NavLink>)}</div>)}
    {planned.length > 0 && <div className="navgroup"><span className="eyebrow">Coming later</span>{planned.map(m => <span key={m} className="planned">{m}<span className="tag">Planned</span></span>)}</div>}</nav>;
  return <div className="shell">
    <a className="skip" href="#main">Skip to content</a>
    <aside className="side"><div className="brand">{businessName}<small>Optizen</small></div>{nav('nav-side', 'Workspace')}<form action={signOut} style={{ marginTop: 'auto' }}><button className="btn" style={{ width: '100%' }}>Sign out</button></form></aside>
    <header className="mbar"><span className="brand">{businessName}</span>
      <details className="mmenu"><summary aria-label="Open menu">Menu</summary><div className="mmenu-body">{nav('nav-mobile', 'Workspace menu')}<form action={signOut}><button className="btn" style={{ width: '100%' }}>Sign out</button></form></div></details></header>
    <main className="main" id="main" tabIndex={-1}>
      <div className="topbar"><form action="/search" method="get" role="search" className="searchbox"><label className="sr-only" htmlFor="gs">Search</label><input id="gs" name="q" type="search" className="input" placeholder="Search leads, tasks, invoices…" minLength={2} maxLength={80} /><button className="btn">Search</button></form>
        <div className="row" style={{ gap: 8 }}>{ai}<CommandSearch items={items} /></div></div>
      {children}</main>
    <nav className="tabbar" aria-label="Quick navigation"><a href="/work">Home</a><a href="/tasks">Follow-ups</a><a href="/search">Search</a><a href="/notifications">Alerts{unread > 0 ? ` (${unread})` : ''}</a></nav>
  </div>;
}
