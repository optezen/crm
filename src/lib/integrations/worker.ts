// Background processing for integrations (runs in the Fly.io worker with the service-role key). All state lives in Postgres; this code is a thin,
// dependency-injected loop so it can be tested offline with mocked HTTP. It never sends anything without stored, decryptable credentials and (for
// WhatsApp) a configured, provider-approved template.
import { decryptJson, type Key } from './crypto.ts';
import { MetaClient, MetaLeadAdapter, type MetaCreds } from './meta.ts';
import { messagingAdapter, toWhatsAppNumber } from './whatsapp.ts';
import { ProviderError, type Fetch } from './types.ts';

type RpcResult = { data: unknown; error: { message: string } | null };
export type WorkerDeps = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>; credentials: (connectionId: string) => Promise<string | null>; fetch: Fetch; key: Key };
const must = async (p: PromiseLike<RpcResult>) => { const r = await p; if (r.error) throw new Error(r.error.message); return r.data; };

async function creds<T>(d: WorkerDeps, connectionId: string): Promise<T> {
  const ct = await d.credentials(connectionId);
  if (!ct) throw new ProviderError('No credentials are stored for this connection.', 'auth', 'no_credentials');
  return decryptJson<T>(ct, d.key);
}
/** Auth failures change the connection state so the owner sees "Expired" / "Error" instead of silent non-delivery. */
async function reportAuth(d: WorkerDeps, connectionId: string, e: ProviderError, expiredOk: boolean) {
  await d.rpc('integration_set_connection_state', { p_conn: connectionId, p_status: expiredOk && e.code === '190' ? 'expired' : 'error', p_error: e.message }); // 'expired' = reconnect with a new token; 'error' = a permission or the Page installation is gone
}

export async function processLeadEvents(d: WorkerDeps, limit = 10): Promise<{ claimed: number; created: number; failed: number }> {
  const events = (await must(d.rpc('integration_claim_events', { p_limit: limit }))) as { id: string; connection_id: string; payload: Record<string, string> }[];
  const adapter = new MetaLeadAdapter(new MetaClient(d.fetch)); let created = 0, failed = 0;
  for (const ev of events) {
    try {
      const lead = await adapter.fetchLead({ page_id: ev.payload.page_id ?? '', leadgen_id: ev.payload.leadgen_id ?? '' }, await creds<MetaCreds>(d, ev.connection_id));
      const r = (await must(d.rpc('integration_ingest_lead', { p_event: ev.id, p_fields: lead.fields, p_meta: lead.meta }))) as { status: string };
      if (r.status === 'created') created++;
      await d.rpc('integration_job', { p_conn: ev.connection_id, p_kind: 'meta_lead_fetch', p_status: 'succeeded', p_items: 1, p_error: null });
    } catch (e) {
      failed++;
      const pe = e instanceof ProviderError ? e : new ProviderError((e as Error).message, 'transient');
      if (pe.kind === 'auth' || (pe.kind === 'permanent' && ['10'].includes(pe.code ?? '') || (pe.kind === 'permanent' && /^2\d\d$/.test(pe.code ?? '')))) await reportAuth(d, ev.connection_id, pe, true);
      await d.rpc('integration_fail_event', { p_event: ev.id, p_message: pe.message, p_retryable: pe.retryable });
      await d.rpc('integration_job', { p_conn: ev.connection_id, p_kind: 'meta_lead_fetch', p_status: 'failed', p_items: 0, p_error: pe.message });
    }
  }
  return { claimed: events.length, created, failed };
}

export async function deliverWhatsApp(d: WorkerDeps, limit = 10): Promise<{ claimed: number; sent: number; failed: number }> {
  const reqs = (await must(d.rpc('integration_claim_requests', { p_limit: limit }))) as { id: string; connection_id: string; payload: { message?: string; phone?: string; template_name?: string; template_language?: string; params?: string[] }; config: Record<string, string> }[];
  let sent = 0, failed = 0;
  for (const r of reqs) {
    try {
      const cfg = r.config ?? {};
      const template = r.payload.template_name ?? cfg.template_name, language = r.payload.template_language ?? cfg.template_language; // reminders carry their own approved template
      if (!template || !language) throw new ProviderError('No approved WhatsApp template is configured on the connection. Add the template name and language.', 'permanent', 'no_template');
      if (!r.payload.phone) throw new ProviderError('The lead has no phone number.', 'permanent', 'no_phone');
      const adapter = messagingAdapter(cfg.provider ?? '', d.fetch);
      const c = await creds<Record<string, string>>(d, r.connection_id);
      const out = await adapter.send({ to: toWhatsAppNumber(r.payload.phone, cfg.default_country_code), templateName: template, language, bodyParams: r.payload.params ?? (r.payload.message ? [r.payload.message] : []), reference: r.id },
        adapter.id === 'meta_cloud' ? { access_token: c.access_token, phone_number_id: cfg.phone_number_id ?? c.phone_number_id } : c);
      await must(d.rpc('integration_complete_request', { p_request: r.id, p_ok: true, p_message_id: out.messageId, p_error: null, p_retryable: false }));
      sent++;
    } catch (e) {
      failed++;
      const pe = e instanceof ProviderError ? e : new ProviderError((e as Error).message, 'transient');
      if (pe.kind === 'auth') await reportAuth(d, r.connection_id, pe, true);
      await d.rpc('integration_complete_request', { p_request: r.id, p_ok: false, p_message_id: null, p_error: pe.message, p_retryable: pe.retryable });
    }
  }
  return { claimed: reqs.length, sent, failed };
}

export async function integrationTick(d: WorkerDeps) {
  const statuses = (await must(d.rpc('integration_apply_status_events', { p_limit: 100 }))) as number;
  const leads = await processLeadEvents(d), messages = await deliverWhatsApp(d);
  const payments = (await must(d.rpc('payment_gateway_apply', { p_limit: 50 }))) as { applied: number; held: number; ignored: number }; // verified gateway events -> payments (or held with a reason)
  return { statuses, leads, messages, payments, busy: statuses + leads.claimed + messages.claimed + payments.applied + payments.held + payments.ignored > 0 };
}
