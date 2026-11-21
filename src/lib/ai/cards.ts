import 'server-only';
import type { getAiContext } from './context';

type Ctx = NonNullable<Awaited<ReturnType<typeof getAiContext>>>;
export type PlanView = { plan: { id: string; title: string; summary: string | null; status: string; phase: string | null; base_revision: number | null }; steps: { key: string; kind: string; title: string; args: Record<string, unknown>; depends_on: string[]; decision: string; state: string; result: Record<string, unknown> | null; error: string | null }[] };
/** Proposal and plan cards for a finished turn, read as the signed-in user (row-level security decides what is visible). */
export async function loadCards(c: Ctx, proposalIds: string[], planIds: string[]) {
  const [props, plans] = await Promise.all([
    proposalIds.length ? c.db.from('ai_proposals').select('id, kind, title, payload, status, workflow_id').in('id', proposalIds) : Promise.resolve({ data: [] }),
    Promise.all(planIds.map(async id => { const r = await c.ctx.rpc('ai_plan_get', { p_org: c.ctx.org, p_plan: id }); return r.error ? null : (r.data as PlanView); })),
  ]);
  return { proposals: props.data ?? [], plans: plans.filter(Boolean) as PlanView[] };
}
