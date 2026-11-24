import { Frame } from '../fixture';
import { WorkflowStudio } from '../../../components/studio/WorkflowStudio';
import type { AutomationDefinition } from '../../../lib/automation/types';
// Sample data only (this route exists only when OPTIZEN_UX_FIXTURES=1). It renders the REAL studio. Saving and publishing call the real server actions, which refuse without a session,
// so browser tests use it for layout, keyboard, preview, validation and AI-panel behaviour, never for persistence.
const COND = (value: string) => ({ op: 'and' as const, conditions: [{ field: 'lead.source', op: 'eq' as const, value }] });
const DEFS: Record<string, AutomationDefinition> = {
  default: { trigger: { event: 'lead.created' }, match: COND('website'), actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] },
  long: { trigger: { event: 'lead.created' }, match: COND('website'), actions: [{ type: 'assign_round_robin' }, { type: 'wait', minutes: 120 }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }, { type: 'notify', recipient: 'lead_assignee', title: 'New website lead: {{lead.full_name}}' }, { type: 'wait', minutes: 1440 }, { type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}, thanks for getting in touch.' }] },
  blank: { trigger: { event: 'lead.created' }, match: COND(''), actions: [{ type: 'assign_round_robin' }] },
};
export default async function Page({ searchParams }: { searchParams: Promise<{ [k: string]: string | undefined }> }) {
  const sp = await searchParams; const def = DEFS[sp.v ?? 'default'] ?? DEFS.default!;
  // "legacy" reproduces the reported bug: an old one-wide-row layout saved together with a 43% viewport.
  const layout = sp.v === 'legacy' ? { v: 1 as const, order: ['n1', 'n2', 'n3', 'n4'], pos: { n1: { x: 40, y: 120 }, n2: { x: 340, y: 120 }, n3: { x: 640, y: 120 }, n4: { x: 940, y: 120 } }, view: { x: 10, y: 10, z: 0.43 } } : null;
  return <Frame><WorkflowStudio id={null} name="Website lead follow-up (sample)" enabled={false} publishedVersion={null} published={null} initial={sp.v === 'legacy' ? null : def} draft={sp.v === 'legacy' ? def : null} layout={layout} token={null}
    modules={[{ key: 'vehicles', label: 'Vehicles', fields: [{ key: 'status', label: 'Status' }] }]} members={[{ id: '00000000-0000-0000-0000-000000000001', email: 'sam@example.test', role: 'employee', active: true }]}
    proposalId={null} banner={null} aiAvailable={sp.ai === '1'} /></Frame>;
}
