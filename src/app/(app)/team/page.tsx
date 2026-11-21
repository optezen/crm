import { notFound } from 'next/navigation';
import { getCrmContext } from '../../../lib/crm/context';
import { listTeam } from '../../../lib/automation/service';
import { listInvitations, memberNames } from '../../../lib/ux/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { ActiveToggle } from './ActiveToggle';
import { canBuild } from '../../../lib/workspace/resolve';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';
import { LocalTime } from '../../../components/ui/LocalTime';
import { StudioNav } from '../../../components/studio/StudioNav';
import { AccessForm, InviteForm, RevokeButton, type BranchOption, type RoleOption } from './TeamForms';

export default async function Team() {
  const ctx = await getCrmContext(); if (!ctx) notFound();
  if (!canBuild(ctx.role)) return <Notice title="Team management is limited to owners and admins">Ask an owner or admin to change who is on the team.</Notice>;
  const db = await supabaseServer();
  const [team, invites, names, cr, br, mb] = await Promise.all([listTeam(db, ctx.organizationId), listInvitations(db, ctx.organizationId), memberNames(db, ctx.organizationId),
    db.from('custom_roles').select('id, name, base_role').eq('organization_id', ctx.organizationId).order('name'), db.from('branches').select('id, name, active').eq('organization_id', ctx.organizationId).eq('active', true).order('name'),
    db.from('member_branches').select('user_id, branch_id').eq('organization_id', ctx.organizationId)]);
  if (!team.ok) return <Notice title="Team could not be loaded">{team.error}</Notice>;
  const owner = ctx.role === 'owner';
  const roles: RoleOption[] = [{ value: 'employee', label: 'Employee' }, { value: 'manager', label: 'Manager' }, ...(owner ? [{ value: 'admin', label: 'Admin' }] : []), ...(cr.data ?? []).filter(r => owner || r.base_role !== 'admin').map(r => ({ value: `custom:${r.id}`, label: `${r.name} (custom, based on ${r.base_role})` }))];
  const branches: BranchOption[] = (br.data ?? []).map(b => ({ id: b.id, name: b.name }));
  const customOf = new Map<string, string | null>(); { const r = await db.from('organization_members').select('user_id, custom_role_id').eq('organization_id', ctx.organizationId); for (const m of r.data ?? []) customOf.set(m.user_id, m.custom_role_id); }
  const open = (invites.ok ? invites.value : []).filter(i => i.status === 'pending' && new Date(i.expires_at) > new Date()); const past = (invites.ok ? invites.value : []).filter(i => !open.includes(i)).slice(0, 8);
  return <div className="stack">
    <StudioNav current="team" />
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Team</h1><p className="muted">Invite people, set what each person can do, and choose which branches they work in. Employees see their own work; they never see configuration.</p></div><a className="btn" href="/team/roles">Roles, permissions and branches</a></div>
    <Card title="Invite someone" description="You get a link to share. It works only for the email address you enter, expires, and can be revoked.">
      <InviteForm roles={roles} branches={branches} /></Card>
    {open.length > 0 && <Card title={`Waiting to join (${open.length})`}><div className="stack" style={{ gap: 0 }}>{open.map(i => <div className="task" key={i.id}><div className="row"><strong>{i.email}</strong><span className="badge">{i.role}</span><span className="muted">expires <LocalTime iso={i.expires_at} /></span><RevokeButton id={i.id} /></div></div>)}</div></Card>}
    <Card title={`Members (${team.value.length})`}>
      {team.value.map(m => { const editable = m.role !== 'owner' && m.userId !== ctx.userId && (owner || m.role !== 'admin'); return <div className="task" key={m.userId}>
        <div className="row"><strong>{names[m.userId] ? `${names[m.userId]} · ` : ''}{m.email}{m.userId === ctx.userId ? ' (you)' : ''}</strong><span className="badge">{m.role}</span>{customOf.get(m.userId) && <span className="tag">custom role</span>}{!m.active && <span className="badge done">Inactive</span>}</div>
        {editable && <><AccessForm userId={m.userId} email={m.email} role={m.role} customRoleId={customOf.get(m.userId) ?? null} roles={roles} branches={branches} mine={(mb.data ?? []).filter(x => x.user_id === m.userId).map(x => x.branch_id)} /><ActiveToggle userId={m.userId} active={m.active} /></>}
      </div>; })}
    </Card>
    {past.length > 0 && <Card title="Recent invitations"><ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>{past.map(i => <li key={i.id}>{i.email} · {i.status === 'pending' ? 'expired' : i.status}</li>)}</ul></Card>}
  </div>;
}
