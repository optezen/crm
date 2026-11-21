// Credential encryption for connections. AES-256-GCM with a random 96-bit IV per value; the 256-bit key lives only in the server environment
// (INTEGRATION_ENCRYPTION_KEY, base64) and never in the database, so a database leak alone exposes no provider tokens.
// Format: "v<keyVersion>:<iv>.<tag>.<ciphertext>" (base64url). Rotation: see docs/KEY_ROTATION.md. A Keyring holds the CURRENT key (used to encrypt) and PREVIOUS versions (decrypt only), so a rotation never
// makes stored credentials unreadable while they are being re-encrypted.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_VERSION = 1;
export function parseKey(b64: string | undefined): Buffer {
  const k = Buffer.from(b64 ?? '', 'base64');
  if (k.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 random bytes encoded as base64 (generate with: openssl rand -base64 32).');
  return k;
}
const b64u = (b: Buffer) => b.toString('base64url');
export type Keyring = { current: Buffer; version: number; previous: Map<number, Buffer> };
export type Key = Buffer | Keyring;
/** INTEGRATION_ENCRYPTION_KEY (current, base64), INTEGRATION_ENCRYPTION_KEY_VERSION (default 1), INTEGRATION_ENCRYPTION_KEY_PREVIOUS ("1:<base64>,0:<base64>"). Throws a clear message when anything is malformed. */
export function keyringFromEnv(env: Record<string, string | undefined>): Keyring {
  const current = parseKey(env.INTEGRATION_ENCRYPTION_KEY); const version = env.INTEGRATION_ENCRYPTION_KEY_VERSION ? Number(env.INTEGRATION_ENCRYPTION_KEY_VERSION) : KEY_VERSION;
  if (!Number.isInteger(version) || version < 1 || version > 9999) throw new Error('INTEGRATION_ENCRYPTION_KEY_VERSION must be a whole number from 1 to 9999.');
  const previous = new Map<number, Buffer>();
  for (const part of (env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,4}):(.+)$/.exec(part); if (!m) throw new Error('INTEGRATION_ENCRYPTION_KEY_PREVIOUS must look like "1:<base64 key>" (comma separated for several).');
    const v = Number(m[1]); if (v === version) throw new Error('INTEGRATION_ENCRYPTION_KEY_PREVIOUS contains the current version number. Give the new key a new version.'); previous.set(v, parseKey(m[2]));
  }
  return { current, version, previous };
}
const isRing = (k: Key): k is Keyring => !Buffer.isBuffer(k);
export function encryptJson(value: unknown, keyOrRing: Key, version = KEY_VERSION): string {
  const key = isRing(keyOrRing) ? keyOrRing.current : keyOrRing; if (isRing(keyOrRing)) version = keyOrRing.version;
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `v${version}:${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
/** The key version a stored credential was encrypted with, or null when it is malformed. */
export const credentialVersion = (token: string): number | null => { const m = /^v(\d+):/.exec(token); return m ? Number(m[1]) : null; };
export function decryptJson<T = unknown>(token: string, keyOrRing: Key): T {
  const m = /^v(\d+):([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(token);
  if (!m) throw new Error('Malformed credential.');
  let key: Buffer; if (isRing(keyOrRing)) { const v = Number(m[1]); const k = v === keyOrRing.version ? keyOrRing.current : keyOrRing.previous.get(v); if (!k) throw new Error(`The credential was encrypted with key version ${v}, which is not configured. Add it to INTEGRATION_ENCRYPTION_KEY_PREVIOUS.`); key = k; } else key = keyOrRing;
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
