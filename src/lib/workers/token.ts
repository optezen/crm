// Worker token helpers. The worker authenticates with a long-lived JWT for the restricted `optizen_worker` role. It cannot verify the signature (only Supabase can), but it can READ the
// expiry claim so it can warn long before the token stops working, and report the days left in its heartbeat. The token itself is never logged or stored.
export function jwtExpiry(token: string | undefined | null): number | null {
  const part = token?.split('.')[1]; if (!part) return null;
  try { const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp; return typeof exp === 'number' && Number.isFinite(exp) ? exp : null; } catch { return null; }
}
/** Whole days until the token expires (negative when it already has), or null when there is no readable expiry. */
export function tokenDaysLeft(token: string | undefined | null, nowMs = Date.now()): number | null {
  const exp = jwtExpiry(token); return exp === null ? null : Math.floor((exp * 1000 - nowMs) / 86_400_000);
}
export const TOKEN_WARN_DAYS = 30;
