export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const CONNECTION_STATUSES = ['not_connected', 'setup_required', 'connected', 'expired', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export const STATUS_LABEL: Record<ConnectionStatus, string> = { not_connected: 'Not connected', setup_required: 'Setup required', connected: 'Connected', expired: 'Expired', error: 'Error' };

export const PROVIDERS = ['website_forms', 'meta_lead_ads', 'whatsapp', 'google_ads', 'telephony', 'payments'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
/** `implemented`: there is code that talks to this provider. `contract`: only the adapter contract exists (docs/INTEGRATIONS.md); nothing can be connected. */
export const PROVIDER_INFO: Record<ProviderId, { label: string; blurb: string; implemented: boolean }> = {
  website_forms: { label: 'Website Forms', blurb: 'Send form submissions from WordPress, Elementor, Next.js or any server to Optizen as CRM leads.', implemented: true },
  meta_lead_ads: { label: 'Meta Lead Ads', blurb: 'Pull Facebook and Instagram lead form submissions into the CRM. Needs a Meta app with approved permissions.', implemented: true },
  whatsapp: { label: 'WhatsApp', blurb: 'Send approved WhatsApp templates from automations through Meta Cloud API or Interakt, and track delivery.', implemented: true },
  google_ads: { label: 'Google Ads', blurb: 'Import Google Ads lead form extensions and conversions. Not available yet.', implemented: false },
  telephony: { label: 'Telephony', blurb: 'Log calls and missed calls against leads. Not available yet.', implemented: false },
  payments: { label: 'Payments', blurb: 'Record payments from a gateway against leads and invoices. Not available yet.', implemented: false },
};

export const CRM_TARGETS = ['full_name', 'first_name', 'last_name', 'phone', 'email', 'summary', 'ignore'] as const;
export type CrmTarget = (typeof CRM_TARGETS)[number];
export const TARGET_LABEL: Record<CrmTarget, string> = { full_name: 'Full name', first_name: 'First name', last_name: 'Last name', phone: 'Phone', email: 'Email', summary: 'Lead summary / message', ignore: 'Ignore this field' };

export type ConnectionRow = { id: string; provider: ProviderId; name: string; status: ConnectionStatus; publicId: string | null; config: Record<string, unknown>; lastEventAt: string | null; lastSyncAt: string | null; lastError: string | null; lastErrorAt: string | null; createdAt: string };
export type AssetRow = { id: string; connectionId: string; kind: string; externalId: string; name: string | null; selected: boolean };
export type EventRow = { id: string; connectionId: string; kind: string; status: string; attempts: number; lastError: string | null; leadId: string | null; receivedAt: string };
export type ErrorRow = { id: string; connectionId: string | null; source: string; code: string | null; message: string; createdAt: string };

/** A provider failure, classified so callers know whether to retry. */
export class ProviderError extends Error {
  readonly kind: 'auth' | 'rate_limit' | 'transient' | 'permanent';
  readonly code?: string;
  constructor(message: string, kind: 'auth' | 'rate_limit' | 'transient' | 'permanent', code?: string) { super(message); this.name = 'ProviderError'; this.kind = kind; this.code = code; }
  get retryable() { return this.kind === 'transient' || this.kind === 'rate_limit'; }
}
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Normalized output of an incoming-lead adapter: flat fields go through the same mapping + CRM path as website forms. */
export type IncomingLead = { externalId: string; fields: Record<string, string>; meta: { provider: Record<string, string> } };
/** Contract every incoming-lead provider implements (Meta Lead Ads today; Google Ads lead forms later). */
export interface LeadSourceAdapter { readonly provider: ProviderId; fetchLead(ref: Record<string, string>, creds: unknown): Promise<IncomingLead> }
/** Contract for outbound messaging (WhatsApp today; SMS later). */
export type OutboundMessage = { to: string; templateName: string; language: string; bodyParams: string[] };
export interface MessagingAdapter { readonly id: string; send(msg: OutboundMessage, creds: unknown): Promise<{ messageId: string }>; verify(creds: unknown): Promise<{ displayName: string }> }
