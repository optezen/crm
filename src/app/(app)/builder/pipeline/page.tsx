import Link from 'next/link';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { draftMeta, loadDraft } from '../../../../lib/workspace/builder';
import { supabaseServer } from '../../../../lib/supabase/server';
import { ensureCore } from '../../../../lib/workspace/schema';
import { Notice } from '../../../../components/ui/Notice';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { PipelineStudio } from '../../../../components/studio/PipelineStudio';

export default async function PipelineStudioPage() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Builder is limited to owners and admins">Ask an owner or admin to change the workspace.</Notice>;
  const db = await supabaseServer();
  const [draft, meta, counts] = await Promise.all([loadDraft(db, s.organizationId), draftMeta(db, s.organizationId), db.from('crm_stage_counts').select('stage, n').eq('organization_id', s.organizationId)]);
  if (!meta.ok) return <Notice title="The Pipeline Builder could not load">{meta.error}</Notice>;
  const published = ensureCore(s.config), draftCfg = draft.ok && draft.value ? ensureCore(draft.value) : null;
  const c: Record<string, number> = Object.fromEntries((counts.data ?? []).map(r => [r.stage as string, r.n as number]));
  return <div className="stack">
    <StudioNav current="pipeline" />
    <div className="top"><div><span className="eyebrow">Optizen Builder Studio</span><h1>Pipeline</h1><p className="muted">The stages every lead moves through. See it as a board in <Link href="/work/leads/board">Work Mode</Link>.</p></div></div>
    <PipelineStudio key={`${meta.value.token}:${meta.value.published}`} published={published} draft={draftCfg} token={meta.value.token} publishedRev={meta.value.published} counts={c} />
  </div>;
}
