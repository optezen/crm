// Operator tool: re-encrypt all stored provider credentials with the current integration key.  node worker/rekey-credentials.mjs [--dry-run]
// Needs SUPABASE_URL + (WORKER_JWT + SUPABASE_ANON_KEY | SUPABASE_SERVICE_ROLE_KEY) and INTEGRATION_ENCRYPTION_KEY / _VERSION / _PREVIOUS. Prints counts only, never a secret. Safe to repeat.
import { database } from './runtime.mjs';
import { keyringFromEnv } from '../src/lib/integrations/crypto.ts';
import { rekeyAll } from '../src/lib/integrations/rekey.ts';
let ring; try { ring = keyringFromEnv(process.env); } catch (e) { console.error(e.message); process.exit(1); }
const { db } = database(); const dryRun = process.argv.includes('--dry-run');
const result = await rekeyAll({
  list: async (after, limit) => { let q = db.from('integration_credentials').select('connection_id, ciphertext').order('connection_id').limit(limit); if (after) q = q.gt('connection_id', after); const r = await q; if (r.error) throw new Error(r.error.message); return r.data ?? []; },
  swap: async (conn, oldC, newC, version) => { const r = await db.rpc('integration_rekey_credential', { p_conn: conn, p_old: oldC, p_new: newC, p_version: version }); if (r.error) throw new Error(r.error.message); return r.data === true; },
}, ring, { dryRun });
const v = await db.rpc('integration_key_versions');
console.log(JSON.stringify({ dryRun, currentVersion: ring.version, ...result, storedByVersion: v.error ? 'unavailable' : v.data }));
if (result.failed > 0) { console.error(`${result.failed} credential(s) could not be re-encrypted (wrong or missing previous key). Nothing was lost; fix INTEGRATION_ENCRYPTION_KEY_PREVIOUS and run again.`); process.exit(2); }
process.exit(0);
