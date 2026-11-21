// Re-encrypts every stored credential with the CURRENT key (integration encryption-key rotation; procedure in docs/KEY_ROTATION.md). Pure logic over two small callbacks so it is tested
// against a real database without any network. It never prints or returns a secret; results are counts only.
import { credentialVersion, decryptJson, encryptJson, type Keyring } from './crypto.ts';

export type Rekeyed = { total: number; alreadyCurrent: number; rekeyed: number; raced: number; failed: number; wouldRekey: number };
export type RekeyDeps = {
  /** one page of stored credentials after the given connection id (ascending) */
  list: (after: string | null, limit: number) => Promise<{ connection_id: string; ciphertext: string }[]>;
  /** compare-and-swap: true only when the row still held `oldCiphertext` */
  swap: (connectionId: string, oldCiphertext: string, newCiphertext: string, version: number) => Promise<boolean>;
};
export async function rekeyAll(deps: RekeyDeps, ring: Keyring, opts: { dryRun?: boolean; pageSize?: number } = {}): Promise<Rekeyed> {
  const out: Rekeyed = { total: 0, alreadyCurrent: 0, rekeyed: 0, raced: 0, failed: 0, wouldRekey: 0 }; let after: string | null = null;
  for (;;) {
    const page = await deps.list(after, opts.pageSize ?? 100); if (!page.length) return out;
    for (const row of page) {
      out.total++; after = row.connection_id;
      if (credentialVersion(row.ciphertext) === ring.version) { out.alreadyCurrent++; continue; }
      try {
        const value = decryptJson(row.ciphertext, ring); const next = encryptJson(value, ring);
        if (JSON.stringify(decryptJson(next, ring)) !== JSON.stringify(value)) throw new Error('round trip failed'); // never write something we cannot read back
        if (opts.dryRun) { out.wouldRekey++; continue; }
        if (await deps.swap(row.connection_id, row.ciphertext, next, ring.version)) out.rekeyed++; else out.raced++;
      } catch { out.failed++; }
    }
  }
}
