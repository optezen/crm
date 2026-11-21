// Payment gateway adapter contract. An adapter turns ONE provider's webhook into normalized events, and nothing else: it cannot record money by itself.
//   1. verify(): the provider's signature over the RAW body with the per-connection webhook secret (constant-time). Unverified traffic is rejected before parsing.
//   2. parse(): normalized events {eventId, kind, providerPaymentId, invoiceId?, amount (major units, 2 decimals), currency, method}.
// The database then stores each event once, applies captured payments through the one payment-posting function, and HOLDS anything it cannot apply cleanly.
// The Razorpay adapter follows Razorpay's documented webhook format (X-Razorpay-Signature = hex HMAC-SHA256 of the body; payment.captured / payment.failed / refund.processed;
// amounts in the smallest currency unit; the invoice id travels in the payment's `notes`). It has been tested with synthetic payloads only, never against a live or sandbox account.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type GatewayEvent = { eventId: string; kind: 'payment_captured' | 'payment_failed' | 'refund_processed'; providerPaymentId: string; invoiceId: string | null; amount: number | null; currency: string | null; method: 'card' | 'upi' | 'bank_transfer' | 'other' | null };
export interface PaymentGatewayAdapter { readonly id: string; verify(rawBody: string, headers: Headers, secret: string): boolean; parse(body: unknown, headers: Headers): GatewayEvent[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']); const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);
/** Minor units -> a 2-decimal major amount; currencies that do not use 2 decimals are refused rather than mis-scaled. */
export function fromMinor(amount: unknown, currency: string): number | null {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > 1e13 || ZERO_DECIMAL.has(currency) || THREE_DECIMAL.has(currency)) return null;
  return Math.round(amount) / 100;
}
export const razorpay: PaymentGatewayAdapter = {
  id: 'razorpay',
  verify(raw, headers, secret) {
    const given = headers.get('x-razorpay-signature'); if (!given || !secret || !/^[0-9a-f]{64}$/i.test(given)) return false;
    const want = createHmac('sha256', secret).update(raw).digest(); const got = Buffer.from(given, 'hex'); return got.length === want.length && timingSafeEqual(got, want);
  },
  parse(body, headers) {
    const b = body as { event?: string; payload?: { payment?: { entity?: { id?: string; amount?: number; currency?: string; method?: string; notes?: Record<string, unknown> | unknown[] } }; refund?: { entity?: { payment_id?: string; id?: string; amount?: number; currency?: string } } } };
    const kind = ({ 'payment.captured': 'payment_captured', 'payment.failed': 'payment_failed', 'refund.processed': 'refund_processed' } as Record<string, GatewayEvent['kind']>)[String(b?.event)]; if (!kind) return [];
    const p = b.payload?.payment?.entity, r = b.payload?.refund?.entity; const pid = String(kind === 'refund_processed' ? r?.payment_id ?? '' : p?.id ?? ''); if (!pid) return [];
    const currency = String((kind === 'refund_processed' ? r?.currency : p?.currency) ?? '').toUpperCase(); const okCur = /^[A-Z]{3}$/.test(currency);
    const notes = p?.notes && !Array.isArray(p.notes) ? p.notes : {}; const inv = typeof notes.invoice_id === 'string' && UUID.test(notes.invoice_id) ? notes.invoice_id.toLowerCase() : null;
    const amount = okCur ? fromMinor(kind === 'refund_processed' ? r?.amount : p?.amount, currency) : null;
    if (kind === 'payment_captured' && (amount === null || !okCur)) return []; // never record a payment whose amount or currency cannot be read exactly
    const method = ({ card: 'card', upi: 'upi', netbanking: 'bank_transfer' } as Record<string, GatewayEvent['method']>)[String(p?.method)] ?? 'other';
    const eventId = headers.get('x-razorpay-event-id') || `${b.event}:${kind === 'refund_processed' ? r?.id ?? pid : pid}`;
    return [{ eventId: eventId.slice(0, 200), kind, providerPaymentId: pid.slice(0, 120), invoiceId: inv, amount, currency: okCur ? currency : null, method: kind === 'payment_captured' ? method : null }];
  },
};
export const gatewayAdapter = (id: string): PaymentGatewayAdapter | null => (id === 'razorpay' ? razorpay : null);
