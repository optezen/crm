import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { draftMeta, loadDraft } from '../../../../lib/workspace/builder';
import { supabaseServer } from '../../../../lib/supabase/server';
import { ensureCore } from '../../../../lib/workspace/schema';
import { Notice } from '../../../../components/ui/Notice';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { FormStudio } from '../../../../components/studio/FormStudio';

export default async function FormsStudio() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Builder is limited to owners and admins">Ask an owner or admin to change the workspace.</Notice>;
  const db = await supabaseServer();
  const [draft, meta] = await Promise.all([loadDraft(db, s.organizationId), draftMeta(db, s.organizationId)]);
  if (!meta.ok) return <Notice title="The Form Builder could not load">{meta.error}</Notice>;
  const published = ensureCore(s.config), draftCfg = draft.ok && draft.value ? ensureCore(draft.value) : null;
  return <div className="stack">
    <StudioNav current="forms" />
    <div className="top"><div><span className="eyebrow">Optizen Builder Studio</span><h1>Forms</h1><p className="muted">Design the form people fill in for each module. Changes are a draft until you publish; existing records are never changed.</p></div></div>
    <FormStudio key={`${meta.value.token}:${meta.value.published}`} published={published} draft={draftCfg} token={meta.value.token} publishedRev={meta.value.published}
      proposalNote={draftCfg ? 'A saved draft exists (for example one the AI prepared). You are editing that same draft.' : null} />
  </div>;
}
