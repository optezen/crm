import 'server-only';
import { getWorkspaceState } from '../workspace/service';
import { supabaseServer } from '../supabase/server';
import { missingFor } from '../integrations/env';
import type { WorkspaceConfig } from '../workspace/types';
import type { Rpc, ToolCtx } from './tools';

/** The only place the assistant's context is built: organization, user and role come from the signed-in user's membership, never from the request body. */
export async function getAiContext(): Promise<{ ctx: ToolCtx; businessName: string; db: Awaited<ReturnType<typeof supabaseServer>> } | null> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return null;
  const db = await supabaseServer();
  const rpc: Rpc = (fn, args) => db.rpc(fn, args) as unknown as ReturnType<Rpc>;
  const loadConfigs: ToolCtx['loadConfigs'] = async () => {
    const pub = await db.from('workspace_configuration_versions').select('definition, revision').eq('organization_id', s.organizationId).eq('status', 'published').order('revision', { ascending: false }).limit(1).single();
    const dr = await db.from('workspace_configuration_versions').select('definition').eq('organization_id', s.organizationId).eq('status', 'draft').maybeSingle();
    if (pub.error || !pub.data) throw new Error('The workspace configuration could not be loaded.');
    return { published: pub.data.definition as WorkspaceConfig, publishedRevision: pub.data.revision as number, draft: (dr.data?.definition as WorkspaceConfig | undefined) ?? null };
  };
  return { db, businessName: s.config.businessName, ctx: { org: s.organizationId, userId: s.userId, role: s.role, conversationId: null, rpc, loadConfigs, platformMissing: () => ({ meta: missingFor('meta'), whatsapp: missingFor('whatsapp') }) } };
}
