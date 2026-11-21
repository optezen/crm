import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetRow, ConnectionRow, ErrorRow, EventRow, Result } from './types.ts';

type Err = { code?: string; message: string };
const dbError = (e: Err): { ok: false; error: string } => ({ ok: false, error: ['22023', '23505', '42501', 'P0002'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.' });
// secret_hash and credential ciphertext are not selectable by clients (column grants); only these columns are ever requested
const CONN_COLS = 'id, provider, name, status, public_id, config, last_event_at, last_sync_at, last_error, last_error_at, created_at';

export type HubData = { connections: ConnectionRow[]; assets: AssetRow[]; mappings: Record<string, { external_field: string; target: string }[]>; events: EventRow[]; errors: ErrorRow[]; counts: Record<string, { received: number; created: number; rejected: number }> };

export async function loadHub(db: SupabaseClient, org: string): Promise<Result<HubData>> {
  const since = new Date(Date.now() - 864e5).toISOString();
  const [c, a, m, e, er] = await Promise.all([
    db.from('integration_connections').select(CONN_COLS).eq('organization_id', org).order('created_at'),
    db.from('integration_assets').select('id, connection_id, kind, external_id, name, selected').eq('organization_id', org).order('name'),
    db.from('integration_field_mappings').select('connection_id, external_field, target').eq('organization_id', org),
    db.from('integration_webhook_events').select('id, connection_id, kind, status, attempts, last_error, lead_id, received_at').eq('organization_id', org).gte('received_at', since).order('received_at', { ascending: false }).limit(300),
    db.from('integration_errors').select('id, connection_id, source, code, message, created_at').eq('organization_id', org).order('created_at', { ascending: false }).limit(15),
  ]);
  const err = c.error ?? a.error ?? m.error ?? e.error ?? er.error; if (err) return dbError(err);
  const connections = (c.data ?? []).map(r => ({ id: r.id, provider: r.provider, name: r.name, status: r.status, publicId: r.public_id, config: r.config ?? {}, lastEventAt: r.last_event_at, lastSyncAt: r.last_sync_at, lastError: r.last_error, lastErrorAt: r.last_error_at, createdAt: r.created_at }) as ConnectionRow);
  const events = (e.data ?? []).map(r => ({ id: r.id, connectionId: r.connection_id, kind: r.kind, status: r.status, attempts: r.attempts, lastError: r.last_error, leadId: r.lead_id, receivedAt: r.received_at }));
  const counts: HubData['counts'] = {};
  for (const ev of events) { const k = (counts[ev.connectionId] ??= { received: 0, created: 0, rejected: 0 }); k.received++; if (ev.leadId) k.created++; if (ev.status === 'rejected' || ev.status === 'dead') k.rejected++; }
  const mappings: HubData['mappings'] = {}; for (const r of m.data ?? []) (mappings[r.connection_id] ??= []).push({ external_field: r.external_field, target: r.target });
  return { ok: true, value: { connections, assets: (a.data ?? []).map(r => ({ id: r.id, connectionId: r.connection_id, kind: r.kind, externalId: r.external_id, name: r.name, selected: r.selected })), mappings, events, counts,
    errors: (er.data ?? []).map(r => ({ id: r.id, connectionId: r.connection_id, source: r.source, code: r.code, message: r.message, createdAt: r.created_at })) } };
}
export async function observedFields(db: SupabaseClient, org: string, conn: string): Promise<string[]> {
  const { data } = await db.rpc('integration_observed_fields', { p_org: org, p_conn: conn }); return (data as string[] | null) ?? [];
}
export { dbError };
