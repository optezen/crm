import { getWorkspaceState } from '../../../../lib/workspace/service';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { loadOperations } from '../../../../lib/ops/health';
import { Notice } from '../../../../components/ui/Notice';
import { OperationsView } from '../../../../components/studio/OperationsView';
import { requeueMessageAction, retryLeadEventAction, retryPaymentAction, retryRunAction } from './actions';

export const dynamic = 'force-dynamic';
export default async function Operations() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Operations are limited to owners and admins">Ask an owner or admin to check background processing.</Notice>;
  const data = await loadOperations(await supabaseServer(), s.organizationId);
  return <div className="stack">
    <StudioNav current="operations" />
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Operations</h1><p className="muted">Is background processing running, is anything stuck, and what needs a person. Everything here comes from live heartbeats and queues; nothing is estimated.</p></div></div>
    {!data.ok ? <Notice title="Operations could not be loaded">{data.error}</Notice> : <OperationsView data={data.value} actions={{ message: requeueMessageAction, lead: retryLeadEventAction, run: retryRunAction, payment: retryPaymentAction }} />}
  </div>;
}
