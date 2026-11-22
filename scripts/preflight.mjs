// node scripts/preflight.mjs web --env-file .env.staging.web         (or: workers | tests), optionally --compare-env-file <workers file> when checking web
// Reads only the file you name (plus nothing from .env.local), prints PASS/WARN/FAIL per item without any value, exits 1 on any FAIL. Also verifies the migration chain.
import { readFileSync, readdirSync } from 'node:fs';
import { preflight, crossCheck, worst } from './lib/preflight.mjs';
const target = process.argv[2]; const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const parse = f => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map(l => /^\s*([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]).filter(([, v]) => v !== ''));
const file = arg('--env-file'); if (!file) { console.error('Usage: node scripts/preflight.mjs <web|workers|tests> --env-file <file>'); process.exit(2); }
const env = parse(file); let items = preflight(target, env);
const cmp = arg('--compare-env-file'); if (cmp && target === 'web') items = items.concat(crossCheck(env, parse(cmp)));
const files = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort(); const ok = files.length >= 26 && files.every((f, i) => Number(f.slice(0, 4)) === i + 1);
items.push({ level: ok ? 'PASS' : 'FAIL', name: `migration chain 0001–${String(files.length).padStart(4, '0')} is contiguous (${files.length} files)`, detail: '' });
for (const i of items) console.log(`${i.level.padEnd(4)}  ${i.name}${i.detail && i.level !== 'PASS' ? `  — ${i.detail}` : ''}`);
const w = worst(items); console.log(w === 2 ? '\nFAIL: fix the items above before deploying.' : w === 1 ? '\nPASS with warnings: the warned features will be skipped.' : '\nAll checks passed.'); process.exit(w === 2 ? 1 : 0);
