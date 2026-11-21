import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { loadDraft, listVersions, draftMeta } from '../../../lib/workspace/builder';
import { supabaseServer } from '../../../lib/supabase/server';
import { aiConfigured } from '../../../lib/workspace/ai';
import { ensureCore } from '../../../lib/workspace/schema';
import { Notice } from '../../../components/ui/Notice';
import { BuilderEditor } from './BuilderEditor';
import { StudioNav } from '../../../components/studio/StudioNav';

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

export default async function Builder() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Builder is limited to owners and admins">Ask an owner or admin to change the workspace.</Notice>;
  const db = await supabaseServer();
  const [draft, versions, meta] = await Promise.all([loadDraft(db, s.organizationId), listVersions(db, s.organizationId), draftMeta(db, s.organizationId)]);
  const published = ensureCore(s.config), draftCfg = draft.ok && draft.value ? ensureCore(draft.value) : null;
  return <div className="stack">
    <StudioNav current="modules" />
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Workspace configuration</h1><p className="muted">Create modules and fields, edit the lead pipeline, preview the changes, and publish a new version. Roll back any time by restoring an earlier version.</p></div></div>
    <Notice title="Your data is protected">Renaming a field or module never changes stored records. Hiding a field keeps its values. A field, module or type that records already use cannot be removed or have its type changed; hide it instead.</Notice>
    {!draft.ok && <Notice title="Draft could not be loaded">{draft.error}</Notice>}
    <BuilderEditor key={hash(JSON.stringify([published, draftCfg, meta.ok ? meta.value : null]))} token={meta.ok ? meta.value.token : null} publishedRev={meta.ok ? meta.value.published : null} published={published} draft={draftCfg} aiAvailable={aiConfigured()} versions={versions.ok ? versions.value : []} />
  </div>;
}
