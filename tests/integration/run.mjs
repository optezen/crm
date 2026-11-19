// `npm run test:integration` — fails (non-zero) when credentials are missing instead of silently skipping,
// so a green result always means real database tests ran.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { configured, guard } from './env.mjs';

if (!configured || guard) {
  console.error(`Integration tests NOT run: ${guard}.\nSee docs/SUPABASE_SETUP.md (local: "supabase start", then copy .env.test.example to .env.test.local).`);
  process.exit(2);
}
const dir = new URL('./', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.itest.mjs')).map(f => new URL(f, dir).pathname)
  .filter(f => process.env.SKIP_APP_TESTS !== '1' || !f.includes('app-routes'));
process.exit(spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' }).status ?? 1);
