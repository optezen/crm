import Link from 'next/link';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { loadDraft, listVersions } from '../../../../lib/workspace/builder';
import { diffConfig, ensureCore } from '../../../../lib/workspace/schema';
import { listWorkflows } from '../../../../lib/automation/service';
import { listInvitations } from '../../../../lib/ux/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { LocalTime } from '../../../../components/ui/LocalTime';
import { StudioNav } from '../../../../components/studio/StudioNav';

/** Builder overview: what is LIVE versus what is only a saved DRAFT, in every area, with one place to start. All numbers are read from the workspace; nothing is sample data. */
export default async function BuilderHome() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Builder is limited to owners and admins">Ask an owner or admin to change the workspace.</Notice>;
  const db = await supabaseServer();
  const [draft, versions, wf, inv, dash, wip] = await Promise.all([loadDraft(db, s.organizationId), listVersions(db, s.organizationId), listWorkflows(db, s.organizationId), listInvitations(db, s.organizationId),
    db.from('dashboards').select('id', { count: 'exact', head: true }).eq('organization_id', s.organizationId), db.from('automation_wip').select('id', { count: 'exact', head: true }).eq('organization_id', s.organizationId)]);
  const live = ensureCore(s.config); const draftCfg = draft.ok && draft.value ? ensureCore(draft.value) : null; const changes = draftCfg ? diffConfig(live, draftCfg) : [];
  const liveV = versions.ok ? versions.value.find(v => v.status === 'published') : undefined, draftV = versions.ok ? versions.value.find(v => v.status === 'draft') : undefined;
  const custom = live.modules.filter(m => !['overview', 'leads'].includes(m.key) && m.status === 'active');
  const wfs = wf.ok ? wf.value : []; const enabled = wfs.filter(w => w.enabled).length, published = wfs.filter(w => w.publishedVersion && !w.enabled).length, draftOnly = wfs.filter(w => !w.publishedVersion).length;
  const pending = (inv.ok ? inv.value : []).filter(i => i.status === 'pending' && new Date(i.expires_at) > new Date()).length;
  const tile = (title: string, status: React.ReactNode, body: React.ReactNode, href: string, cta: string) => <Card title={title}><div className="stack" style={{ gap: 8 }}><div>{status}</div><p className="muted" style={{ margin: 0 }}>{body}</p><div><Link className="btn" href={href}>{cta}</Link></div></div></Card>;
  return <div className="stack">
    <StudioNav current="home" />
    <div className="top"><div><span className="eyebrow">Customize</span><h1>Set up {live.businessName}</h1><p className="muted">Change how your workspace works. Your changes stay private as a draft until you publish them, so your team never sees half-finished work.</p></div></div>
    {changes.length > 0 && <Notice title={`You have a saved draft with ${changes.length} change${changes.length === 1 ? '' : 's'} that is NOT live`}>It was saved {draftV ? <LocalTime iso={draftV.createdAt} /> : 'earlier'}. <Link href="/builder">Review and publish it</Link>, or discard it there.</Notice>}
    <div className="grid">
      {tile('Modules and forms', <><span className="badge">Live{liveV ? ` v${liveV.revision}` : ''}</span> {draftCfg && <span className="badge done">Draft saved</span>}</>, `${custom.length === 0 ? 'Only Leads so far.' : `${custom.length} custom module${custom.length === 1 ? '' : 's'}: ${custom.map(m => m.label).join(', ')}.`} Add modules, fields and form layouts; roll back from the version history.`, '/builder', 'Open modules')}
      {tile('Lead pipeline', <span className="badge">{live.pipeline.stages.length} stages live</span>, live.pipeline.stages.join(' → '), '/builder/pipeline', 'Edit the pipeline')}
      {tile('Automations', <><span className="badge">{enabled} running</span> {published > 0 && <span className="badge done">{published} paused</span>} {draftOnly > 0 && <span className="badge done">{draftOnly} draft only</span>} {(wip.count ?? 0) > 0 && <span className="badge done">{wip.count} unfinished</span>}</>, 'Automate routine work. Drafts do not run until you publish and enable them.', '/automations', 'Open automations')}
      {tile('Dashboards and reports', <span className="badge">{dash.count ?? 0} dashboard{dash.count === 1 ? '' : 's'}</span>, 'Built only from real data in your workspace.', '/dashboards', 'Open dashboards')}
      {tile('Team and roles', <><span className="badge">{pending} invitation{pending === 1 ? '' : 's'} waiting</span></>, 'Invite employees, choose roles and branches, and limit what each role can see.', '/team', 'Manage the team')}
      {tile('Connections', <span className="badge done">Optional</span>, 'WhatsApp, Meta ads and other connections. Nothing is sent until a connection is set up.', '/builder/connections', 'Open connections')}
      {s.role === 'owner' && tile('Optizen AI', <span className="badge done">Owner only</span>, 'Provider status, usage and limits. You can also ask the assistant to set things up; it only prepares drafts for your approval.', '/settings/ai', 'AI settings')}
    </div>
  </div>;
}
