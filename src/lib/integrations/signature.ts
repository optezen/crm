// Meta (Facebook Lead Ads and WhatsApp Cloud API) signs every webhook POST: header X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, appSecret).
// Verify against the RAW bytes before parsing JSON, and compare in constant time.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMetaSignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim()); if (!m) return false;
  const want = createHmac('sha256', appSecret).update(rawBody).digest(), got = Buffer.from(m[1]!, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
export const signMeta = (rawBody: string, appSecret: string) => 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex'); // for tests and examples
