import 'server-only';
import { getWorkspaceState } from '../workspace/service';
import { supabaseServer } from '../supabase/server';
import type { CrmContext } from './types';

/** The only place the UI builds a CrmContext: organization and role come from the user's membership, never from the request. */
export async function getCrmContext(): Promise<CrmContext | null> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return null;
  return { db: await supabaseServer(), organizationId: s.organizationId, userId: s.userId, role: s.role, stages: s.config.pipeline.stages };
}

export const leadsModuleActive = async () => {
  const s = await getWorkspaceState();
  return s.status === 'ready' && s.config.modules.some(m => m.key === 'leads' && m.status === 'active');
};
