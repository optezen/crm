// Credential encryption for connections. AES-256-GCM with a random 96-bit IV per value; the 256-bit key lives only in the server environment
// (INTEGRATION_ENCRYPTION_KEY, base64) and never in the database, so a database leak alone exposes no provider tokens.
// Format: "v<keyVersion>:<iv>.<tag>.<ciphertext>" (base64url). Bump the version prefix when the key is rotated; keep old keys available to decrypt.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_VERSION = 1;
export function parseKey(b64: string | undefined): Buffer {
  const k = Buffer.from(b64 ?? '', 'base64');
  if (k.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 random bytes encoded as base64 (generate with: openssl rand -base64 32).');
  return k;
}
const b64u = (b: Buffer) => b.toString('base64url');
export function encryptJson(value: unknown, key: Buffer, version = KEY_VERSION): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `v${version}:${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
export function decryptJson<T = unknown>(token: string, key: Buffer): T {
  const m = /^v(\d+):([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(token);
  if (!m) throw new Error('Malformed credential.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m[2]!, 'base64url'));
  d.setAuthTag(Buffer.from(m[3]!, 'base64url'));
  try { return JSON.parse(Buffer.concat([d.update(Buffer.from(m[4]!, 'base64url')), d.final()]).toString('utf8')) as T; }
  catch { throw new Error('The stored credential could not be decrypted (wrong key or tampered data).'); }
}

/** Signed, expiring state for OAuth round trips (CSRF protection): the callback must present the same nonce that the browser cookie holds. */
export function signState(payload: Record<string, unknown>, key: Buffer): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64u(createHmac('sha256', key).update(body).digest())}`;
}
export function verifyState<T = Record<string, unknown>>(state: string, key: Buffer, now = Date.now()): T | null {
  const [body, sig] = state.split('.'); if (!body || !sig) return null;
  const want = createHmac('sha256', key).update(body).digest(), got = Buffer.from(sig, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: number }; return typeof p.exp === 'number' && p.exp > now ? (p as T) : null; } catch { return null; }
}
