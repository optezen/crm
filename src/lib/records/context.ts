import 'server-only';
import { getWorkspaceState } from '../workspace/service';
import { supabaseServer } from '../supabase/server';
import type { RecordsContext } from './types';

export async function getRecordsContext(): Promise<RecordsContext | null> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return null;
  return { db: await supabaseServer(), organizationId: s.organizationId, userId: s.userId, role: s.role, config: s.config };
}
