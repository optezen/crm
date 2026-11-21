// Mints a long-lived JWT for the restricted `optizen_worker` Postgres role. Run it once, by an operator, with the project's JWT secret; give ONLY the resulting token to the workers.
//   SUPABASE_JWT_SECRET=... node worker/mint-worker-token.mjs [days=365]
// The token can call the worker functions and read encrypted credential blobs, nothing else (no tables, no RLS bypass). To revoke it, rotate the JWT secret or drop the role grant.
import { createHmac } from 'node:crypto';
const secret = process.env.SUPABASE_JWT_SECRET; if (!secret) { console.error('Set SUPABASE_JWT_SECRET (Project settings > API > JWT secret).'); process.exit(1); }
const days = Math.min(Math.max(Number(process.argv[2]) || 365, 1), 3650), b = o => Buffer.from(JSON.stringify(o)).toString('base64url'), now = Math.floor(Date.now() / 1000);
const head = b({ alg: 'HS256', typ: 'JWT' }), body = b({ role: 'optizen_worker', iss: 'optizen-worker', iat: now, exp: now + days * 86400 });
process.stdout.write(`${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}\n`);
