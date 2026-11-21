import { notFound } from 'next/navigation';
import { getCrmContext } from '../../../lib/crm/context';
import { listTeam } from '../../../lib/automation/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { ActiveToggle } from './ActiveToggle';
import { ASSIGNABLE_ROLES } from '../../../lib/crm/types';
import { canBuild } from '../../../lib/workspace/resolve';
import { ActionForm } from '../../../components/ui/ActionForm';
import { Card } from '../../../components/ui/Card';
import { Field } from '../../../components/ui/Field';
import { Notice } from '../../../components/ui/Notice';
import { addMemberAction, setRoleAction } from './actions';

export default async function Team() {
  const ctx = await getCrmContext(); if (!ctx) notFound();
  if (!canBuild(ctx.role)) return <Notice title="Team management is limited to owners and admins">Ask an owner or admin to change who is on the team.</Notice>;
  const res = await listTeam(await supabaseServer(), ctx.organizationId);
  if (!res.ok) return <Notice title="Team could not be loaded">{res.error}</Notice>;
  const roles = ctx.role === 'owner' ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter(r => r !== 'admin');
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Team</h1><p className="muted">Owners and admins manage who can work in this workspace. Managers can assign any lead; employees see their own and unassigned leads. Inactive members are skipped by automatic assignment.</p></div></div>
    {canBuild(ctx.role) && <p><a className="btn" href="/team/roles">Roles, permissions and branches</a></p>}
    <Card title="Add a team member" description="They must have signed in to Optizen once with this email.">
      <ActionForm action={addMemberAction} submit="Add to team" resetOnSuccess>
        <div className="form-grid">
          <Field id="email" name="email" label="Email" type="email" required />
          <div className="field"><label htmlFor="role">Role</label><select id="role" name="role" className="input" defaultValue="employee">{roles.map(r => <option key={r}>{r}</option>)}</select></div>
        </div>
      </ActionForm>
    </Card>
    <Card title={`Members (${res.value.length})`}>
      {res.value.map(m => <div className="task" key={m.userId}>
        <div className="row"><strong>{m.email}{m.userId === ctx.userId ? ' (you)' : ''}</strong><span className="badge">{m.role}</span>{!m.active && <span className="badge done">Inactive</span>}</div>
        {m.role !== 'owner' && m.userId !== ctx.userId && (ctx.role === 'owner' || m.role !== 'admin') && <ActiveToggle userId={m.userId} active={m.active} />}
        {m.role !== 'owner' && m.userId !== ctx.userId && (ctx.role === 'owner' || m.role !== 'admin') &&
          <ActionForm action={setRoleAction} submit="Change role" className="inline">
            <input type="hidden" name="userId" value={m.userId} />
            <div className="field"><label htmlFor={`role-${m.userId}`}>Role</label><select id={`role-${m.userId}`} name="role" className="input" defaultValue={m.role}>{roles.map(r => <option key={r}>{r}</option>)}</select></div>
          </ActionForm>}
      </div>)}
    </Card>
  </div>;
}
