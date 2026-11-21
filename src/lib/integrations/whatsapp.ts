// Provider-independent WhatsApp messaging. Two adapters implement the same MessagingAdapter contract. Both are written from the providers'
// public documentation and tested ONLY with mocked HTTP; no message has ever been sent. Sending needs authorized credentials AND a template that
// the provider has approved, so the worker never sends free text.
import { ProviderError, type Fetch, type MessagingAdapter, type OutboundMessage } from './types.ts';
import { classify, GRAPH_VERSION, type GatewayEvent } from './meta.ts';

export type MetaCloudCreds = { access_token: string; phone_number_id: string };
export type InteraktCreds = { api_key: string };

/** E.164 digits without "+". A number without a country code is refused (never guessed) unless the connection has a default country code. */
export function toWhatsAppNumber(raw: string, defaultCountryCode?: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.slice(1);
  if (defaultCountryCode && /^\d{1,3}$/.test(defaultCountryCode)) return defaultCountryCode + digits.replace(/^0+/, '');
  throw new ProviderError('The phone number has no country code. Save it with +<country code>, or set a default country code on the WhatsApp connection.', 'permanent', 'no_country_code');
}

export class MetaCloudAdapter implements MessagingAdapter {
  readonly id = 'meta_cloud';
  private readonly fetch: Fetch;
  private readonly version: string;
  constructor(fetch: Fetch, version = GRAPH_VERSION) { this.fetch = fetch; this.version = version; }
  private async call(path: string, creds: MetaCloudCreds, init?: { method?: string; body?: unknown }) {
    let res; try { res = await this.fetch(`https://graph.facebook.com/${this.version}${path}`, { method: init?.method ?? 'GET', headers: { authorization: `Bearer ${creds.access_token}`, 'content-type': 'application/json' }, body: init?.body ? JSON.stringify(init.body) : undefined }); }
    catch (e) { throw new ProviderError(`Could not reach WhatsApp: ${(e as Error).message}`, 'transient'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw classify(res.status, body);
    return (body ?? {}) as Record<string, unknown>;
  }
  async verify(creds: unknown): Promise<{ displayName: string }> {
    const c = creds as MetaCloudCreds;
    const b = await this.call(`/${encodeURIComponent(c.phone_number_id)}?fields=display_phone_number,verified_name`, c);
    return { displayName: `${b.verified_name ?? 'WhatsApp'} (${b.display_phone_number ?? c.phone_number_id})` };
  }
  async send(msg: OutboundMessage, creds: unknown): Promise<{ messageId: string }> {
    const c = creds as MetaCloudCreds;
    const b = await this.call(`/${encodeURIComponent(c.phone_number_id)}/messages`, c, { method: 'POST', body: {
      messaging_product: 'whatsapp', to: msg.to, type: 'template', ...(msg.reference ? { biz_opaque_callback_data: msg.reference } : {}),
      template: { name: msg.templateName, language: { code: msg.language }, components: msg.bodyParams.length ? [{ type: 'body', parameters: msg.bodyParams.map(text => ({ type: 'text', text })) }] : [] } } });
    const id = (b.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new ProviderError('WhatsApp accepted the request but returned no message id.', 'permanent');
    return { messageId: id };
  }
}

/** Interakt public API (https://api.interakt.ai). Authorization is "Basic <api key>". Delivery-status webhooks for Interakt are NOT implemented. */
export class InteraktAdapter implements MessagingAdapter {
  readonly id = 'interakt';
  private readonly fetch: Fetch;
  constructor(fetch: Fetch) { this.fetch = fetch; }
  async verify(): Promise<{ displayName: string }> { throw new ProviderError('Interakt has no read-only credential check. The key is first used when a message is sent.', 'permanent', 'unverifiable'); }
  async send(msg: OutboundMessage, creds: unknown): Promise<{ messageId: string }> {
    const c = creds as InteraktCreds;
    const country = msg.to.length > 10 ? msg.to.slice(0, msg.to.length - 10) : '91', phone = msg.to.slice(-10);
    let res; try { res = await this.fetch('https://api.interakt.ai/v1/public/message/', { method: 'POST', headers: { authorization: `Basic ${c.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ countryCode: `+${country}`, phoneNumber: phone, type: 'Template', template: { name: msg.templateName, languageCode: msg.language, bodyValues: msg.bodyParams } }) }); }
    catch (e) { throw new ProviderError(`Could not reach Interakt: ${(e as Error).message}`, 'transient'); }
    const body = await res.json().catch(() => null) as { result?: boolean; id?: string; message?: string } | null;
    if (res.status === 401 || res.status === 403) throw new ProviderError('Interakt rejected the API key.', 'auth', String(res.status));
    if (res.status === 429) throw new ProviderError('Interakt rate limit.', 'rate_limit', '429');
    if (res.status >= 500) throw new ProviderError('Interakt is temporarily unavailable.', 'transient', String(res.status));
    if (!res.ok || !body?.result || !body.id) throw new ProviderError(body?.message ?? `Interakt returned HTTP ${res.status}`, 'permanent', String(res.status));
    return { messageId: body.id };
  }
}
export const messagingAdapter = (provider: string, fetch: Fetch): MessagingAdapter => {
  if (provider === 'interakt') return new InteraktAdapter(fetch);
  if (provider === 'meta_cloud') return new MetaCloudAdapter(fetch);
  throw new ProviderError('Choose a WhatsApp provider on the connection.', 'permanent');
};

/** WhatsApp Cloud API webhook -> delivery status events, routed by phone_number_id. Inbound customer messages are intentionally ignored. */
export function parseWhatsAppWebhook(body: unknown): GatewayEvent[] {
  const out: GatewayEvent[] = [];
  const b = body as { object?: string; entry?: { changes?: { field?: string; value?: { metadata?: { phone_number_id?: string }; statuses?: { id?: string; status?: string; biz_opaque_callback_data?: string; errors?: { code?: number; title?: string; message?: string }[] }[] } }[] }[] };
  if (b?.object !== 'whatsapp_business_account') return out;
  for (const e of b.entry ?? []) for (const c of e.changes ?? []) {
    const phone = c.value?.metadata?.phone_number_id; if (c.field !== 'messages' || !phone) continue;
    for (const s of c.value?.statuses ?? []) {
      if (!s.id || !s.status) continue;
      const err = s.errors?.[0];
      out.push({ kind: 'whatsapp_status', asset_kind: 'phone_number', asset_id: phone, dedupe_key: `${s.id}:${s.status}`, payload: { message_id: s.id, status: s.status, ...(s.biz_opaque_callback_data ? { callback: s.biz_opaque_callback_data.slice(0, 64) } : {}), ...(err ? { error: `${err.code ?? ''} ${err.title ?? err.message ?? ''}`.trim() } : {}) } });
    }
  }
  return out;
}
