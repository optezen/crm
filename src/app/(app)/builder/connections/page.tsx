import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { loadHub } from '../../../../lib/integrations/service';
import { missingFor } from '../../../../lib/integrations/env';
import { Notice } from '../../../../components/ui/Notice';
import { ConnectionsHub } from './ConnectionsHub';

export default async function Connections({ searchParams }: { searchParams: Promise<{ error?: string; meta?: string; pages?: string }> }) {
  const sp = await searchParams;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Connections are limited to owners and admins">Ask an owner or admin to connect external services.</Notice>;
  const hub = await loadHub(await supabaseServer(), s.organizationId);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Builder</span><h1>Connections</h1><p className="muted">Bring leads in from your website and ad platforms, and send WhatsApp messages from automations. A card only says “Connected” after the service has really accepted your credentials.</p></div></div>
    {sp.error && <Notice title="Connection problem">{sp.error}</Notice>}
    {sp.meta === 'authorized' && <Notice title="Meta authorized">Meta returned {sp.pages ?? 0} Page(s). Choose which Pages should send leads below.</Notice>}
    {!hub.ok && <Notice title="Connections could not be loaded">{hub.error}</Notice>}
    {hub.ok && <ConnectionsHub data={hub.value} siteUrl={site} metaMissing={missingFor('meta')} whatsappMissing={missingFor('whatsapp')} />}
  </div>;
}
