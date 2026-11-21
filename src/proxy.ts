import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Refreshes the Supabase session cookie. Server Components cannot write cookies, so without this
// a rotated refresh token is lost and returning users get signed out once the access token expires.
export async function proxy(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();
  let res = NextResponse.next({ request: req });
  const db = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list, headers) => {
        list.forEach(c => req.cookies.set(c.name, c.value));
        res = NextResponse.next({ request: req });
        list.forEach(c => res.cookies.set(c.name, c.value, c.options));
        Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v)); // no-store: never cache set-cookie responses
      },
    },
  });
  await db.auth.getUser();
  return res;
}

// webhooks carry their own credentials and have no session, so they skip the session refresh
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/health).*)'] };
