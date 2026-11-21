import type { SupabaseClient } from '@supabase/supabase-js';
import { dbError } from '../integrations/service.ts';
import type { ConnectionStatus, Result } from '../integrations/types.ts';

export type WorkerRow = { worker: string; instance: string; last_seen: string; started_at: string; version: string | null; healthy: boolean; last_error: string | null; last_error_at: string | null; stats: Record<string, unknown> };
export type Queues = { automation_runs: Record<string, number>; oldest_queued_run_seconds: number | null; webhook_events: Record<string, number>; messages: Record<string, number>; uncertain_messages: number; reminders_pending: number };
export type MessageLogRow = { id: string; request_id: string; event: string; detail: string | null; template: string | null; at: string; can_requeue: boolean };
export type FailedLead = { id: string; connection: string; status: string; attempts: number; lastError: string | null; receivedAt: string };
export type DeadRun = { id: string; lastError: string | null; createdAt: string };
export type OpsConnection = { id: string; provider: string; name: string; status: ConnectionStatus; lastError: string | null; lastErrorAt: string | null };
export type OpsError = { id: string; source: string; code: string | null; message: string; createdAt: string };
export type HeldPayment = { id: string; kind: string; amount: number | null; currency: string | null; reason: string | null; received_at: string };
export type PaymentsView = { held: HeldPayment[]; applied_without_payment: number; gateway_payments_without_event: number; gateway_total_by_currency: Record<string, number>; manual_total_by_currency: Record<string, number> };
export type OpsData = { now: string; workers: WorkerRow[]; queues: Queues; messages: MessageLogRow[]; failedLeads: FailedLead[]; deadRuns: DeadRun[]; connections: OpsConnection[]; errors: OpsError[]; payments: PaymentsView | null };

/** Everything an administrator needs to see whether background processing is healthy. Reads go through administrator-only database functions and
 * row-level security; no credential, token or message text is ever selected. */
export async function loadOperations(db: SupabaseClient, org: string): Promise<Result<OpsData>> {
  const [w, m, ev, runs, c, er, pay] = await Promise.all([
    db.rpc('worker_status', { p_org: org }), db.rpc('outbound_messages_recent', { p_org: org, p_limit: 40 }),
    db.from('integration_webhook_events').select('id, connection_id, status, attempts, last_error, received_at').eq('organization_id', org).eq('kind', 'meta_leadgen').in('status', ['failed', 'dead']).order('received_at', { ascending: false }).limit(20),
    db.from('automation_runs').select('id, last_error, created_at').eq('organization_id', org).eq('status', 'dead').order('created_at', { ascending: false }).limit(20),
    db.from('integration_connections').select('id, provider, name, status, last_error, last_error_at').eq('organization_id', org).order('created_at'),
    db.from('integration_errors').select('id, source, code, message, created_at').eq('organization_id', org).order('created_at', { ascending: false }).limit(15),
    db.rpc('payment_reconcile', { p_org: org }),
  ]);
  const err = w.error ?? m.error ?? ev.error ?? runs.error ?? c.error ?? er.error; if (err) return dbError(err);
  const status = w.data as { now: string; workers: WorkerRow[]; queues: Queues };
  const names = new Map((c.data ?? []).map(r => [r.id as string, r.name as string]));
  return { ok: true, value: { now: status.now, workers: status.workers, queues: status.queues, messages: (m.data as MessageLogRow[]) ?? [],
    failedLeads: (ev.data ?? []).map(r => ({ id: r.id, connection: names.get(r.connection_id) ?? 'Connection', status: r.status, attempts: r.attempts, lastError: r.last_error, receivedAt: r.received_at })),
    deadRuns: (runs.data ?? []).map(r => ({ id: r.id, lastError: r.last_error, createdAt: r.created_at })),
    connections: (c.data ?? []).map(r => ({ id: r.id, provider: r.provider, name: r.name, status: r.status, lastError: r.last_error, lastErrorAt: r.last_error_at })),
    errors: (er.data ?? []).map(r => ({ id: r.id, source: r.source, code: r.code, message: r.message, createdAt: r.created_at })),
    payments: pay.error ? null : (pay.data as PaymentsView) } }; // null when billing is off for this workspace
}
