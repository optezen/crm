import { notFound } from 'next/navigation';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { RolesManager, type DirRow, type RoleRow } from '../../../../components/RolesManager';
import { Notice } from '../../../../components/ui/Notice';

export default async function Roles() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') notFound();
  if (!canBuild(s.role)) return <Notice title="Roles are limited to owners and admins">Ask an owner or admin to change roles, branches or permissions.</Notice>;
  const db = await supabaseServer(), org = s.organizationId;
  const [roles, dir, br, loc] = await Promise.all([db.from('custom_roles').select('id, name, base_role, permissions, scopes, location_restricted').eq('organization_id', org).order('name'), db.rpc('team_directory', { p_org: org }),
    db.from('branches').select('id, name, active').eq('organization_id', org).order('name'), db.from('inventory_locations').select('id, name, branch_id').eq('organization_id', org).order('name')]);
  const customModules = s.config.modules.filter(m => m.status === 'active' && !['overview', 'leads'].includes(m.key) && s.config.objects.some(o => o.key === m.key)).map(m => ({ key: m.key, label: m.label }));
  return <div className="stack">
    <StudioNav current="team" />
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Roles and permissions</h1><p className="muted">Decide who can see, create, edit, export, assign and approve in each module, and which records they see. Every rule is enforced by the database, so it also applies to reports, exports, automations and the AI assistant.</p></div></div>
    <RolesManager roles={(roles.data ?? []) as RoleRow[]} directory={((dir.data as DirRow[] | null) ?? [])} branches={br.data ?? []} locations={loc.data ?? []} customModules={customModules} isOwner={s.role === 'owner'} selfId={s.userId} />
  </div>;
}
