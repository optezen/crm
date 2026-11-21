import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { canBuild } from '../../../../../lib/workspace/resolve';
import { authUrl } from '../../../../../lib/integrations/meta';
import { keyringFromEnv, signState } from '../../../../../lib/integrations/crypto';
import { missingFor } from '../../../../../lib/integrations/env';

export const dynamic = 'force-dynamic';
const back = (req: Request, msg: string) => NextResponse.redirect(new URL(`/builder/connections?error=${encodeURIComponent(msg)}`, req.url));

/** Starts the Meta OAuth flow. Only a signed-in owner/admin can start it; the signed state binds the round trip to this user, organization and browser. */
export async function GET(req: Request) {
  const s = await getWorkspaceState();
  if (s.status !== 'ready' || !canBuild(s.role)) return back(req, 'Only owners and admins can connect Meta.');
  const missing = missingFor('meta'); if (missing.length) return back(req, `Meta is not configured on this deployment: ${missing.join(', ')}.`);
  const nonce = randomBytes(16).toString('hex');
  const state = signState({ org: s.organizationId, user: s.userId, nonce, exp: Date.now() + 10 * 60_000 }, keyringFromEnv(process.env).current);
  const res = NextResponse.redirect(authUrl({ appId: process.env.META_APP_ID!, redirectUri: `${process.env.NEXT_PUBLIC_SITE_URL}/api/integrations/meta/callback`, state }));
  res.cookies.set('optizen_meta_oauth', nonce, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 600, path: '/api/integrations/meta' });
  return res;
}
