// Environment checklist for a staging deployment. Pure: takes an env object, returns PASS/FAIL/WARN items. Values are NEVER included in any message; only names, lengths and yes/no facts.
import { checkTarget, projectRef } from '../../src/lib/env-guard.ts';

const decode = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };
const b64key = v => { try { return Buffer.from(v ?? '', 'base64').length === 32; } catch { return false; } };
const LEVEL = { PASS: 0, WARN: 1, FAIL: 2 };

export function preflight(target, env) {
  const out = []; const add = (level, name, detail = '') => out.push({ level, name, detail }); const has = k => !!env[k];
  const need = (k, test, why) => { if (!has(k)) return add('FAIL', `${k} is set`, why); const bad = test?.(env[k]); bad ? add('FAIL', `${k} is valid`, bad) : add('PASS', `${k} is set and valid`); };
  const forbid = (k, why, level = 'FAIL') => has(k) ? add(level, `${k} is NOT set here`, why) : add('PASS', `${k} is not set here`);
  const stagingRef = env.STAGING_SUPABASE_REF;
  const jwtRef = (k, role) => { if (role === 'anon' && /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(env[k] ?? '')) return null; /* new-style publishable key: not a JWT, the project cannot be read from it */ if (role === 'service_role' && /^sb_secret_[A-Za-z0-9_-]{20,}$/.test(env[k] ?? '')) return null; const p = decode(env[k]); if (!p) return `${k} is not a JWT`; if (p.role !== role) return `${k} has role "${p.role}", expected "${role}"`; if (p.ref && stagingRef && p.ref !== stagingRef) return `${k} belongs to a different Supabase project than STAGING_SUPABASE_REF`; return null; };
  if (target === 'web') {
    need('OPTIZEN_ENV', v => (v === 'staging' ? null : 'must be "staging" on the staging web app'), 'set OPTIZEN_ENV=staging');
    need('STAGING_SUPABASE_REF', v => (/^[a-z0-9]{10,30}$/.test(v) ? null : 'a project ref looks like abcdefghijklmnop'), 'the staging project ref');
    need('NEXT_PUBLIC_SUPABASE_URL', v => (projectRef(v) ? null : 'must be https://<ref>.supabase.co'), 'the staging API URL');
    need('NEXT_PUBLIC_SUPABASE_ANON_KEY', () => jwtRef('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon'), 'the staging anon key');
    need('NEXT_PUBLIC_SITE_URL', v => (/^https:\/\/[^/\s]+$/.test(v) ? null : 'must be https://host with no path or trailing slash'), 'the staging web origin');
    need('INTEGRATION_ENCRYPTION_KEY', v => (b64key(v) ? null : 'must be 32 random bytes as base64 (openssl rand -base64 32)'), 'a NEW key for staging');
    need('INTEGRATION_GATEWAY_SECRET', v => (v.length >= 32 ? null : 'must be at least 32 characters'), 'registered once in the database');
    need('OPS_HEALTH_TOKEN', v => (v.length >= 16 ? null : 'must be at least 16 characters'), 'for the uptime monitor');
    forbid('SUPABASE_SERVICE_ROLE_KEY', 'the service-role key must never be on the web app'); forbid('WORKER_JWT', 'worker credentials do not belong on the web app'); forbid('SUPABASE_JWT_SECRET', 'the JWT secret is for the operator machine only');
    has('META_APP_ID') === has('META_APP_SECRET') && has('META_APP_SECRET') === has('META_WEBHOOK_VERIFY_TOKEN') ? add('PASS', 'Meta settings are all set or all unset') : add('FAIL', 'Meta settings are complete', 'META_APP_ID, META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN go together');
    has('ANTHROPIC_API_KEY') ? add('PASS', 'AI key present (use a spend-capped test key on staging)') : add('WARN', 'ANTHROPIC_API_KEY not set', 'AI assistant and voice stay off; AI and voice tests will be skipped');
    has('META_APP_ID') ? add('PASS', 'Meta app configured (use a TEST app / roles-only access)') : add('WARN', 'Meta not configured', 'Meta Lead Ads validation will be skipped');
  } else if (target === 'workers') {
    need('OPTIZEN_ENV', v => (v === 'staging' ? null : 'must be "staging"'), 'set OPTIZEN_ENV=staging'); need('STAGING_SUPABASE_REF', v => (/^[a-z0-9]{10,30}$/.test(v) ? null : 'invalid ref'), 'the staging project ref');
    need('SUPABASE_URL', v => (projectRef(v) ? null : 'must be https://<ref>.supabase.co'), 'the staging API URL'); need('SUPABASE_ANON_KEY', () => jwtRef('SUPABASE_ANON_KEY', 'anon'), 'the staging anon key');
    if (has('WORKER_JWT')) { const p = decode(env.WORKER_JWT); p?.role === 'optizen_worker' ? add('PASS', 'WORKER_JWT is for the optizen_worker role') : add('FAIL', 'WORKER_JWT is for the optizen_worker role', 'mint it with worker/mint-worker-token.mjs'); const days = p?.exp ? Math.floor((p.exp * 1000 - Date.now()) / 864e5) : -1; days >= 30 ? add('PASS', `WORKER_JWT valid for ${days} more days`) : add('FAIL', 'WORKER_JWT has at least 30 days left', `${days} day(s) left`); }
    else if (has('WORKER_JWT_FILE')) add('PASS', 'WORKER_JWT_FILE is set (the file is read at runtime)'); else add('FAIL', 'WORKER_JWT or WORKER_JWT_FILE is set', 'mint a token with worker/mint-worker-token.mjs');
    need('INTEGRATION_ENCRYPTION_KEY', v => (b64key(v) ? null : 'must be 32 random bytes as base64'), 'must equal the web app key');
    forbid('SUPABASE_SERVICE_ROLE_KEY', 'workers should use the restricted WORKER_JWT; the service-role key is a logged fallback', 'WARN'); forbid('SUPABASE_JWT_SECRET', 'the JWT secret is for the operator machine only');
  } else if (target === 'tests') {
    need('SUPABASE_TEST_URL', v => (projectRef(v) ? null : 'must be https://<ref>.supabase.co for staging'), 'the staging API URL'); need('SUPABASE_TEST_ANON_KEY', () => jwtRef('SUPABASE_TEST_ANON_KEY', 'anon'), 'staging anon key'); need('SUPABASE_TEST_SERVICE_ROLE_KEY', () => jwtRef('SUPABASE_TEST_SERVICE_ROLE_KEY', 'service_role'), 'staging service-role key (test machine only)');
    env.SUPABASE_TEST_ALLOW_REMOTE === '1' ? add('PASS', 'SUPABASE_TEST_ALLOW_REMOTE=1') : add('FAIL', 'SUPABASE_TEST_ALLOW_REMOTE=1', 'required to run against a remote project');
    need('SUPABASE_TEST_STAGING_REF', v => (v === projectRef(env.SUPABASE_TEST_URL) ? null : 'does not match SUPABASE_TEST_URL'), 'the staging ref'); has('SUPABASE_PRODUCTION_REF') ? add('PASS', 'SUPABASE_PRODUCTION_REF is set (second lock)') : add('WARN', 'SUPABASE_PRODUCTION_REF not set', 'recommended: a second lock against the production project');
    need('APP_URL', v => (/^https?:\/\//.test(v) ? null : 'must be the running staging app URL'), 'the staging web origin'); env.NEXT_PUBLIC_SITE_URL && env.APP_URL && env.APP_URL.replace(/\/$/, '') !== env.NEXT_PUBLIC_SITE_URL ? add('WARN', 'APP_URL differs from NEXT_PUBLIC_SITE_URL', 'cookies and redirects may not line up') : null;
  } else add('FAIL', 'target is web, workers or tests');
  const guard = target === 'tests' ? null : checkTarget(env); guard ? add('FAIL', 'target guard accepts this configuration', guard) : add('PASS', 'target guard accepts this configuration');
  return out.filter(Boolean);
}
/** Cross-checks between the web app and worker configuration: the encryption key must be the same value. */
export function crossCheck(web, workers) { const eq = (a, b) => a && b && a === b; return [{ level: eq(web.INTEGRATION_ENCRYPTION_KEY, workers.INTEGRATION_ENCRYPTION_KEY) ? 'PASS' : 'FAIL', name: 'web and workers use the same INTEGRATION_ENCRYPTION_KEY', detail: '' }, { level: projectRef(web.NEXT_PUBLIC_SUPABASE_URL) && projectRef(web.NEXT_PUBLIC_SUPABASE_URL) === projectRef(workers.SUPABASE_URL) ? 'PASS' : 'FAIL', name: 'web and workers point at the same project', detail: '' }]; }
export const worst = items => items.reduce((m, i) => Math.max(m, LEVEL[i.level]), 0);
