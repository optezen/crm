/** A post-login destination is accepted only if it is a same-site path we expect (no scheme, no host, no protocol-relative URL). */
export function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200 || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\u0000-\u001f]/.test(v)) return null;
  return /^\/(invite\/[0-9a-f]{64}|work(\/[a-z0-9\-\/]*)?|tasks|search|notifications|account)$/.test(v) ? v : null;
}
