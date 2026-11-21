// A minimal stand-in for Supabase's REST API in front of the REAL test PostgreSQL, so the real worker processes (worker/*.mjs, supabase-js) can run against it.
// It does what PostgREST does that matters for security: verifies the HS256 JWT (signature and expiry), maps the `role` claim to a database role, runs every request in its own
// transaction under `set local role`, and returns database errors as PostgREST-style JSON. Only the few table reads the workers use are implemented; everything else is a 404.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const isJson = v => v !== null && typeof v === 'object';
export const signJwt = (secret, claims) => { const b = o => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}`; return `${h}.${createHmac('sha256', secret).update(h).digest('base64url')}`; };
function verifyJwt(token, secret) {
  const [h, p, s] = (token ?? '').split('.'); if (!h || !p || !s) return null; const want = createHmac('sha256', secret).update(`${h}.${p}`).digest(); const got = Buffer.from(s, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null; const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return c.exp && c.exp * 1000 < Date.now() ? null : c;
}
const READABLE = { integration_credentials: ['connection_id', 'ciphertext'] }; // column-level grant of the worker role

export async function startRestMock(pool, jwtSecret, port = 0) {
  const stats = { requests: 0, unauthorized: 0, rpc: {} };
  const server = createServer(async (req, res) => {
    const send = (code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    stats.requests++; const url = new URL(req.url, 'http://x'); const claims = verifyJwt((req.headers.authorization ?? '').replace(/^Bearer /i, ''), jwtSecret);
    if (!claims || !['optizen_worker', 'service_role'].includes(claims.role)) { stats.unauthorized++; return send(401, { code: 'PGRST301', message: 'JWT invalid or expired' }); }
    const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString('utf8'); const c = await pool.connect();
    try {
      await c.query('begin'); await c.query(`set local role ${claims.role}`);
      const rpc = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(url.pathname);
      if (rpc && req.method === 'POST') {
        const args = raw ? JSON.parse(raw) : {}; const keys = Object.keys(args); stats.rpc[rpc[1]] = (stats.rpc[rpc[1]] ?? 0) + 1;
        const call = `public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`).join(', ')})`, params = keys.map(k => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]));
        const meta = (await c.query(`select p.proretset as is_set, (p.prorettype = 'pg_catalog.record'::regtype) as is_table from pg_proc p where p.oid = ($1)::regproc`, [`public.${rpc[1]}`]).catch(() => ({ rows: [] }))).rows[0];
        if (meta?.is_set) { const r = await c.query(`select * from ${call}`, params); await c.query('commit'); return send(200, r.rows.map(x => (meta.is_table ? x : Object.values(x)[0]))); } // SETOF -> JSON array, like PostgREST
        const r = await c.query(`select ${call} r`, params); await c.query('commit'); const v = r.rows[0].r; return send(200, v === '' || v === undefined ? null : v);
      }
      const tbl = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
      if (tbl && req.method === 'GET' && READABLE[tbl[1]]) {
        const cols = (url.searchParams.get('select') ?? '').split(',').map(x => x.trim()); if (!cols.every(x => READABLE[tbl[1]].includes(x))) { await c.query('rollback'); return send(403, { code: '42501', message: 'permission denied' }); }
        const where = [], params = []; for (const [k, v] of url.searchParams) { const m = /^(eq|gt)\.(.+)$/.exec(v); if (m && READABLE[tbl[1]].includes(k)) { params.push(m[2]); where.push(`${k} ${m[1] === 'eq' ? '=' : '>'} $${params.length}`); } }
        const lim = Math.min(Number(url.searchParams.get('limit')) || 100, 1000); const rows = (await c.query(`select ${cols.join(', ')} from public.${tbl[1]} ${where.length ? 'where ' + where.join(' and ') : ''} order by connection_id limit ${lim}`, params)).rows; await c.query('commit');
        if ((req.headers.accept ?? '').includes('vnd.pgrst.object')) return rows.length === 1 ? send(200, rows[0]) : send(406, { code: 'PGRST116', message: 'The result contains 0 rows' });
        return send(200, rows);
      }
      await c.query('rollback'); return send(404, { message: 'not found' });
    } catch (e) { await c.query('rollback').catch(() => {}); return send(400, { code: e.code ?? 'XX000', message: e.message, details: null, hint: null }); }
    finally { c.release(); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, stats, close: () => new Promise(r => server.close(r)) };
}
