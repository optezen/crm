import { Notice } from './ui/Notice';
export function SetupNotice() {
  return <Notice title="Supabase is not connected">
    <p>Sign-in and saved workspaces need a Supabase project. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code>, apply the migrations in <code>supabase/migrations</code>, then restart. Nothing is stored until then.</p>
  </Notice>;
}
