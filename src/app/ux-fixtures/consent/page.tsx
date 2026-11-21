import { Frame } from '../fixture';
import { ConsentCard } from '../../../components/crm/ConsentCard';
import { setConsent, type ConsentView } from '../../../lib/crm/consent';
import type { FormState } from '../../../components/ui/ActionForm';
import type { CrmContext } from '../../../lib/crm/types';

// Sample data only. The action runs the REAL validation (setConsent) against a fake database that accepts the call.
async function save(_: FormState, f: FormData): Promise<FormState> {
  'use server';
  const ctx = { organizationId: 'org', db: { rpc: async () => ({ error: null }) } } as unknown as CrmContext;
  const r = await setConsent(ctx, String(f.get('contactId')), f.get('status'), f.get('note'), f.get('confirm') === 'on');
  return r.ok ? { ok: 'Consent saved.' } : { error: r.error };
}
const none: ConsentView = { current: null, history: [], whatsappReady: false };
const optedOut: ConsentView = { current: { status: 'opted_out', source: 'customer_reply', note: 'WhatsApp reported the customer stopped messages', updatedAt: '2026-11-20T10:00:00.000Z' }, whatsappReady: true,
  history: [{ status: 'opted_out', source: 'customer_reply', note: 'stopped', createdAt: '2026-11-20T10:00:00.000Z' }, { status: 'opted_in', source: 'staff', note: 'Asked on the phone', createdAt: '2026-11-01T10:00:00.000Z' }] };
export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams; const view = state === 'opted_out' ? optedOut : none;
  return <Frame><h1>Consent fixture</h1><ConsentCard view={view} contactId="11111111-1111-4111-8111-111111111111" hasPhone={state !== 'nophone'} action={save} /></Frame>;
}
