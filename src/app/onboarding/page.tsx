import { redirect } from 'next/navigation';
import { getWorkspaceState } from '../../lib/workspace/service';
import { Wizard } from './Wizard';

export default async function Onboarding() {
  const s = await getWorkspaceState();
  if (s.status === 'ready') redirect('/work');
  if (s.status === 'unauthenticated') redirect('/login');
  const blocked = s.status === 'unconfigured' ? 'Supabase is not configured, so the workspace cannot be saved yet. You can still review what would be created.'
    : s.status === 'error' ? s.message : undefined;
  return <main className="center"><Wizard blocked={blocked} /></main>;
}

export const dynamic = 'force-dynamic'; // reads env + session per request; never prerender
