// Refuses to start against the wrong Supabase project. OPTIZEN_ENV says what this deployment is (production | staging | development). The project ref in NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL
// must agree: a staging deployment can never point at the production project, and a production deployment can never point at the staging one. Pure function so it is tested without a network.
export type GuardEnv = Record<string, string | undefined>;
export const projectRef = (url: string | undefined): string | null => /^https:\/\/([a-z0-9]{10,30})\.supabase\.(co|in)(\/|$)/.exec(url ?? '')?.[1] ?? null;
/** null when the target is acceptable, otherwise a plain-language reason to refuse. */
export function checkTarget(env: GuardEnv): string | null {
  const mode = env.OPTIZEN_ENV; const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL; const ref = projectRef(url);
  if (!mode) return null; // not declared: development / local stack, nothing to compare
  if (!['production', 'staging', 'development'].includes(mode)) return `OPTIZEN_ENV must be production, staging or development (got "${mode}").`;
  if (mode === 'development') return null;
  if (!url) return null; // no database configured: the app shows setup notices and persists nothing
  if (!ref) return `OPTIZEN_ENV=${mode} but the Supabase URL is not a hosted project URL.`;
  if (mode === 'staging') {
    if (!env.STAGING_SUPABASE_REF) return 'OPTIZEN_ENV=staging requires STAGING_SUPABASE_REF (the staging project ref) so the target can be verified.';
    if (ref !== env.STAGING_SUPABASE_REF) return `This staging deployment points at project ${ref.slice(0, 4)}…, which is not STAGING_SUPABASE_REF. Refusing to start.`;
    if (env.SUPABASE_PRODUCTION_REF && ref === env.SUPABASE_PRODUCTION_REF) return 'This staging deployment points at the PRODUCTION project. Refusing to start.';
  } else if (env.STAGING_SUPABASE_REF && ref === env.STAGING_SUPABASE_REF) return 'This production deployment points at the STAGING project. Refusing to start.';
  return null;
}
