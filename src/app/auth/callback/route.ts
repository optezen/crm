import { NextResponse, type NextRequest } from 'next/server';
import { supabaseConfigured, supabaseServer } from '../../../lib/supabase/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (code && supabaseConfigured()) {
    const { error } = await (await supabaseServer()).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL('/work', req.url));
  }
  return NextResponse.redirect(new URL('/login', req.url));
}
