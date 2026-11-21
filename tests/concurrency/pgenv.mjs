// A REAL PostgreSQL server (embedded-postgres: the official binaries) with the full migration chain, and one genuine connection per concurrent call.
// PGlite is a single backend and cannot show races; this can. Roles are emulated the way PostgREST does it: one transaction per call, `set local role`, JWT subject claim.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const freePort = () => new Promise(r => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
export const uid = n => `00000000-0000-0000-0000-0000000000${n}`;
export const [EMP, EMP2, MGR, ADM] = ['c3', 'd4', 'e5', 'f6'].map(uid);
const isJson = v => v !== null && typeof v === 'object';

export async function startPg({ migrations = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optizen-pg-')); const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start(); await server.createDatabase('t');
  const conf = { host: 'localhost', port, user: 'postgres', password: 'pw', database: 't' };
  const pool = new pg.Pool({ ...conf, max: 60 }); pool.on('error', () => {});
  await pool.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  await Promise.all(Array.from({ length: 40 }, () => pool.connect())).then(cs => cs.forEach(c => c.release())); // warm 40 backends so concurrent calls really start together
  if (migrations) for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  /** One transaction on its own connection, like a PostgREST request. role: 'authenticated' | 'anon' | 'service_role' | 'optizen_worker'. Returns { data, error, pid }. */
  const rpc = async (user, fn, args = {}, role) => {
    const c = await pool.connect(); const r = role ?? (user ? 'authenticated' : 'anon');
    try {
      await c.query('begin'); await c.query(`set local role ${r}`); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user ?? '']);
      const pid = (await c.query('select pg_backend_pid() p')).rows[0].p; const keys = Object.keys(args); const t0 = Date.now();
      try {
        const res = await c.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, keys.map(k => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
        await c.query('commit'); return { data: res.rows[0].r, error: null, pid, t0, t1: Date.now() };
      } catch (e) { await c.query('rollback').catch(() => {}); return { data: null, error: { code: e.code, message: e.message }, pid, t0, t1: Date.now() }; }
    } finally { c.release(); }
  };
  /** Run a read as a signed-in user (for table functions and views). */
  const asUser = async (user, sql, params) => { const c = await pool.connect(); try { await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]); const r = await c.query(sql, params); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); } };
  const q = async (sql, params) => (await pool.query(sql, params)).rows; // superuser: for assertions only
  const stop = async () => { await pool.end().catch(() => {}); await server.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); };
  return { rpc, q, asUser, pool, stop, port, conf };
}
