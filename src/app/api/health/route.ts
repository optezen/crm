export const dynamic = 'force-dynamic';
/** Liveness of the web app itself (no database, no secrets). Used by deploy checks and uptime monitors. */
export async function GET() { return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
