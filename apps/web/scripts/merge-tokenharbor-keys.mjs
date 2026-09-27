#!/usr/bin/env node
// Merge a fresh batch of TokenHarbor keys into the existing provider pool.
// Usage: node --env-file=apps/web/.env scripts/merge-tokenharbor-keys.mjs [live_keys.txt]
//
// Re-running the onboard script would REPLACE credentials_enc and silently drop
// the keys already in the pool, so this decrypts the blob, appends the new keys
// deduped by api_key, and re-encrypts in place.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_FILE = process.argv[2] || '/home/dwizzy/th-bot/th_probe_live.txt';
const PROVIDER_ID = 'tokenharbor';

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]).toString('utf8'));
}

function encrypt(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const incoming = readFileSync(KEY_FILE, 'utf8')
  .split('\n').map((l) => l.trim())
  .filter((l) => l.startsWith('thk_'));
console.log(`incoming keys: ${incoming.length}`);

try {
  const [row] = await sql`select credentials_enc from provider where id = ${PROVIDER_ID}`;
  if (!row) { console.error(`provider ${PROVIDER_ID} not found`); process.exit(1); }

  const cred = decrypt(row.credentials_enc);
  const existing = new Set(cred.accounts.map((a) => a.api_key));
  console.log(`existing accounts: ${cred.accounts.length}`);

  let added = 0;
  for (const key of incoming) {
    if (existing.has(key)) continue;
    existing.add(key);
    cred.accounts.push({
      email: `tokenharbor-key-${existing.size}@tokenharbor.ai`,
      api_key: key,
      access_token: key,
      refresh_token: null,
      expired: '2099-01-01T00:00:00Z',
    });
    added++;
  }
  console.log(`new keys added: ${added}`);

  if (added > 0) {
    const res = await sql`update provider set credentials_enc = ${encrypt(cred)} where id = ${PROVIDER_ID}`;
  // An UPDATE matching no rows succeeds: assert the write landed instead of
  // trusting the exit code (see references/pool-maintenance.md).
  if (res.count !== 1) {
    console.error(`persist matched ${res.count} provider rows (expected 1)`);
    process.exit(1);
  }
    console.log(`pool now holds ${cred.accounts.length} keys`);
  } else {
    console.log('nothing new — pool unchanged');
  }
  console.log('\n✅ merge done. Restart router to reload the pool.');
} finally {
  await sql.end();
}
