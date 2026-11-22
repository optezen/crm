// Safe targeting of a database for the staging scripts. A remote database is accepted only when the operator names the staging project ref on the command line AND it matches the connection
// string AND it is not the production project. Local databases (localhost / 127.0.0.1) are always allowed for rehearsals. Nothing here prints a password or a full connection string.
import { readFileSync, existsSync } from 'node:fs';

const hostRef = h => /^db\.([a-z0-9]{10,30})\.supabase\.(co|in)$/.exec(h)?.[1] ?? null;
export function describeTarget(urlString) {
  const u = new URL(urlString); const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname); const ref = hostRef(u.hostname) ?? /^postgres\.([a-z0-9]{10,30})$/.exec(decodeURIComponent(u.username))?.[1] ?? null;
  return { local, ref, host: u.hostname, database: u.pathname.slice(1) || 'postgres' };
}
/** The production-labelled project's ref, from SUPABASE_PRODUCTION_REF or (read locally, never printed) the URL in .env.local / .env.production. */
export function productionRef(env = process.env) {
  if (env.SUPABASE_PRODUCTION_REF) return env.SUPABASE_PRODUCTION_REF;
  for (const f of ['.env.production', '.env.local']) if (existsSync(f)) { const m = /^NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]{10,30})\.supabase\.(co|in)/m.exec(readFileSync(f, 'utf8')); if (m) return m[1]; }
  return null;
}
/** Returns null when the target may be used, otherwise the reason to stop. */
export function targetProblem(urlString, { confirmRef, env = process.env } = {}) {
  let t; try { t = describeTarget(urlString); } catch { return 'The database URL is not valid.'; }
  if (t.local) return null;
  if (!t.ref) return 'The database host is not a Supabase project host (db.<ref>.supabase.co or the pooler user postgres.<ref>).';
  if (!confirmRef) return 'Name the staging project: pass --confirm-ref <staging project ref>.';
  if (confirmRef !== t.ref) return 'The connection string points at a different project than --confirm-ref. Stopping.';
  const prod = productionRef(env); if (prod && prod === t.ref) return 'This is the PRODUCTION-labelled project. Refusing.';
  if (env.STAGING_SUPABASE_REF && env.STAGING_SUPABASE_REF !== t.ref) return 'The project is not STAGING_SUPABASE_REF. Stopping.';
  return null;
}

/** Loads KEY=value lines from a git-ignored env file into process.env (values already in the environment win). Never prints a value. */
export function loadEnvFile(file) {
  if (!file) return; if (!existsSync(file)) { console.error(`Env file not found: ${file}`); process.exit(2); }
  for (const line of readFileSync(file, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line); if (!m) continue; const v = m[2].trim().replace(/^["']|["']$/g, ''); if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v; }
}
