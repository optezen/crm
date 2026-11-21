import 'server-only';
import { createClient } from '@supabase/supabase-js';
/** Anonymous Supabase client for the public webhook routes. It holds NO user session and NO service-role key: the connection secret / gateway secret in each RPC call is the credential. */
export const anonClient = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
export const supabaseReady = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
