import { Frame } from '../fixture';
import { PaymentsConnection } from '../../../components/studio/PaymentsConnection';
import type { ConnectionRow } from '../../../lib/integrations/types';

// Sample data only; the actions are stand-ins that enforce the same rule as the database (activation needs a verified notification).
const conn = (over: Partial<ConnectionRow>): ConnectionRow => ({ id: '22222222-2222-4222-8222-222222222222', provider: 'payments', name: 'Razorpay', status: 'setup_required', publicId: 'abc123def456', config: { gateway: 'razorpay' }, lastEventAt: null, lastSyncAt: null, lastError: null, lastErrorAt: null, createdAt: '2026-11-20T00:00:00.000Z', ...over });
async function create() { 'use server'; return { ok: true as const, message: 'Created (sample).' }; }
async function saveSecret(_id: string, secret: string) { 'use server'; return secret.trim().length < 8 ? { ok: false as const, error: 'The webhook secret must be 8 to 128 characters with no spaces. Copy it exactly from the gateway.' } : { ok: true as const, message: 'Secret saved (sample).' }; }
async function activate() { 'use server'; return { ok: true as const, message: 'Payments are active (sample).' }; }
async function disconnect() { 'use server'; return { ok: true as const, message: 'Disconnected (sample).' }; }
export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  const connection = state === 'none' || state === 'missing' ? null : state === 'verified' ? conn({ lastEventAt: '2026-11-21T09:00:00.000Z' }) : state === 'active' ? conn({ status: 'connected', lastEventAt: '2026-11-21T09:00:00.000Z' }) : conn({});
  return <Frame><h1>Payments fixture</h1><PaymentsConnection connection={connection} siteUrl="https://app.example.test" secretSaved={state === 'verified' || state === 'active'} missing={state === 'missing' ? ['INTEGRATION_GATEWAY_SECRET'] : []} actions={{ create, saveSecret, activate, disconnect }} /></Frame>;
}
