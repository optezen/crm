import { AppShell } from '../../components/ux/AppShell';
import type { ReactNode } from 'react';
async function noSignOut() { 'use server'; }
export const GROUPS = [{ title: 'Work', links: [{ label: 'Home', href: '/ux-fixtures/home' }, { label: 'Leads', href: '/work/leads' }, { label: 'Follow-ups', href: '/tasks' }] }, { title: 'You', links: [{ label: 'Notifications (2)', href: '/notifications' }, { label: 'Account', href: '/account' }] }];
export function Frame({ children }: { children: ReactNode }) {
  return <AppShell businessName="Fixture Co (test data)" groups={GROUPS} planned={[]} unread={2} items={[{ label: 'Home', href: '/ux-fixtures/home' }]} signOut={noSignOut} ai={null}>{children}</AppShell>;
}
