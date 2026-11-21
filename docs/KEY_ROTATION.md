# Integration encryption-key rotation

`INTEGRATION_ENCRYPTION_KEY` encrypts every stored provider credential (Meta tokens, WhatsApp tokens, Razorpay webhook secrets) with AES-256-GCM. The key lives only in the environment of the web app and the workers, never in the database. Each stored value records which key version encrypted it (`v1:…`), so a rotation never makes data unreadable.

Tested by `npm run test:workers` (`[keys]` tests: dry run, wrong old key, a credential refreshed mid-rotation, repeat runs, audit trail without secrets, who may call the re-key function).

## When
Yearly, when a person with access to the key leaves, or after any suspected exposure of the key or of a database backup together with the key.

## Procedure (no downtime, about 15 minutes)
Keep the old key until step 6. All commands run from an operator machine with access to the secrets.

1. **Generate** the new key and choose the next version number (the current one is `INTEGRATION_ENCRYPTION_KEY_VERSION`, default `1`):
   `openssl rand -base64 32`
2. **Configure both keys** on the web app **and** the workers. New key becomes current, old key moves to PREVIOUS:
   ```
   INTEGRATION_ENCRYPTION_KEY=<new key>
   INTEGRATION_ENCRYPTION_KEY_VERSION=2
   INTEGRATION_ENCRYPTION_KEY_PREVIOUS=1:<old key>        # comma separated if there are several: "1:<k1>,0:<k0>"
   ```
   Deploy the web app and restart the workers. From now on new credentials use version 2 and old ones still decrypt. A mismatched or malformed setting stops the process at start with a clear message instead of failing later.
3. **Dry run** (changes nothing, reports counts):
   `SUPABASE_URL=… SUPABASE_ANON_KEY=… WORKER_JWT=… INTEGRATION_ENCRYPTION_KEY=… INTEGRATION_ENCRYPTION_KEY_VERSION=2 INTEGRATION_ENCRYPTION_KEY_PREVIOUS=1:… node worker/rekey-credentials.mjs --dry-run`
4. **Re-encrypt**: the same command without `--dry-run`. Each credential is decrypted with its old key, encrypted with the new one, read back to prove it round-trips, and swapped with a compare-and-swap: if the app refreshed that credential meanwhile (for example a renewed Meta token) it is skipped and picked up on the next run, never overwritten with stale data. Exit code 2 means some credentials could not be decrypted (a previous key is missing): nothing was lost, fix `…_PREVIOUS` and run again.
5. **Verify** the output shows `storedByVersion: {"2": N}` (only the new version). Spot-check in Builder → Connections that a WhatsApp or Meta connection still shows Connected and Operations shows no new errors.
6. **Retire the old key** from `…_PREVIOUS` (redeploy). **Keep a sealed copy of the old key until every database backup that predates step 4 has expired**: those backups still contain version-1 ciphertext. Destroying the old key after that point is what makes the rotation effective against a leaked old backup.

## If something goes wrong
- Workers log "key version N is not configured": add `N:<that key>` to `INTEGRATION_ENCRYPTION_KEY_PREVIOUS`.
- You changed the key but did not set a new version number: the old credentials fail with "could not be decrypted (wrong key or tampered data)". Put the old key back (or add it under its version) and retry.
- Lost the old key before re-encrypting: affected connections must be reconnected (tokens re-entered). Nothing else is affected.

## Worker token (separate secret)
The workers authenticate with a JWT for the restricted `optizen_worker` role (`worker/mint-worker-token.mjs`). Heartbeats report `token_days_left`; Builder → Operations warns below 30 days. Renew without restarting: write the new token into the file named by `WORKER_JWT_FILE` (it is re-read on every request), or `fly secrets set WORKER_JWT=…` for a rolling restart. Overlap is free: a new token can be minted and deployed while the old one is still valid, and the old one simply expires. To revoke a token early, rotate the project's JWT secret (this signs everyone out, schedule it).
