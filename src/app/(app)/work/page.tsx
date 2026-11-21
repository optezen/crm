import { getWorkspaceState } from '../../../lib/workspace/service';
import { getCrmContext } from '../../../lib/crm/context';
import { stageCounts } from '../../../lib/crm/service';
import { homeSummary, memberNames } from '../../../lib/ux/service';
import { OPS_MODULES, opsAccess, opsEnabled } from '../../../lib/operations/ops';
import { supabaseServer } from '../../../lib/supabase/server';
import { Notice } from '../../../components/ui/Notice';
import { HomeView } from '../../../components/ux/HomeView';
import { canBuild } from '../../../lib/workspace/resolve';


/** Work Mode home. Role-aware and built only from the signed-in user's own data: nothing here is sample data, and a module that is off or not allowed for the role is simply absent. */
export default async function Work() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const db = await supabaseServer(); const tz = s.config.operations?.appointments?.timezone ?? 'UTC';
  await db.rpc('notifications_generate_overdue', { p_org: s.organizationId }); // idempotent; in-app only (there is no background sender)
  const leadsOn = s.config.modules.some(m => m.key === 'leads' && m.status === 'active'); const ctx = leadsOn ? await getCrmContext() : null;
  const [h, names, counts] = await Promise.all([homeSummary(db, s.organizationId, tz), memberNames(db, s.organizationId), ctx && s.role !== 'employee' ? stageCounts(ctx) : null]);
  if (!h.ok) return <Notice title="Your home screen could not be loaded">Please refresh the page. If it keeps happening, sign out and back in.</Notice>;
  const d = h.value; const manager = s.role !== 'employee'; const builder = canBuild(s.role);
  const custom = s.config.modules.filter(m => m.status === 'active' && !['overview', 'leads'].includes(m.key)).slice(0, 3).map(m => ({ key: m.key, label: m.label }));
  const ops = OPS_MODULES.filter(m => opsEnabled(s.config, m.key) && opsAccess(s.role, m.key));
  return <HomeView d={d} businessName={s.config.businessName} me={names[s.userId]} manager={manager} builder={builder} leadsOn={leadsOn} tz={tz} apptOn={ops.some(m => m.key === 'appointments')} billingOn={ops.some(m => m.key === 'billing')} custom={custom} stages={s.config.pipeline.stages} counts={counts?.ok ? counts.value : null} />;
}
