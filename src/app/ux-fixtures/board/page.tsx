import { Frame } from '../fixture';
import { KanbanBoard } from '../../../components/studio/KanbanBoard';
async function move(id: string, stage: string): Promise<{ ok: true } | { ok: false; error: string }> { 'use server'; return id === 'c3' && stage === 'Won' ? { ok: false, error: 'A lead needs an assignee before it can move to "Won".' } : { ok: true }; }
export default function Page() {
  return <Frame><h1>Board fixture</h1><KanbanBoard stages={['New', 'Qualified', 'Won']} move={move} noun="lead" cards={[
    { id: 'c1', stage: 'New', title: 'Sample Lead A', meta: 'website · unassigned', summary: 'Wants a quote', href: '/work/leads/c1' }, { id: 'c2', stage: 'Qualified', title: 'Sample Lead B', meta: 'phone', summary: null, href: '/work/leads/c2' }, { id: 'c3', stage: 'New', title: 'Sample Lead C', meta: 'referral', summary: null, href: '/work/leads/c3' }]} /></Frame>;
}
