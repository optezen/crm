import { checkTarget } from './lib/env-guard';
/** Runs once when the server starts. A deployment that points at the wrong Supabase project never begins serving. */
export function register() { const problem = checkTarget(process.env); if (problem) throw new Error(`Startup refused: ${problem}`); }
