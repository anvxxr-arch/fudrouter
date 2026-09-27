#!/usr/bin/env node
// Merge freshly farmed Mingles keys into the existing provider pool.
// Usage: node --env-file=apps/web/.env scripts/merge-mingles-keys.mjs [keys.json]
//
// Re-running an onboard script would REPLACE credentials_enc and silently drop
// the keys already pooled, so this decrypts the blob, appends new keys deduped
// by api_key, and re-encrypts in place. Idempotent — safe to run on a timer.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEYS_FILE = process.argv[2] || '/home/dwizzy/mingles-router-farmer/mingles_keys.json';
const PROVIDER_ID = 'mingles';

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

const incoming = JSON.parse(readFileSync(KEYS_FILE, 'utf8'))
  .filter((a) => a && typeof a.key === 'string' && a.key.startsWith('sk-'));
console.log(`incoming keys: ${incoming.length}`);

try {
  const [row] = await sql`select credentials_enc from provider where id = ${PROVIDER_ID}`;
  if (!row) { console.error(`provider ${PROVIDER_ID} not found — run onboard-mingles.mjs first`); process.exit(1); }

  const cred = decrypt(row.credentials_enc);
  const seen = new Set(cred.accounts.map((a) => a.api_key));
  console.log(`existing accounts: ${cred.accounts.length}`);

  let added = 0, skipped = 0;
  for (const a of incoming) {
    if (seen.has(a.key)) { skipped++; continue; }
    seen.add(a.key);
    cred.accounts.push({
      email: a.email || `mingles-key-${a.key.slice(-6)}@mingles`,
      api_key: a.key,
      refresh_token: null,
      access_token: a.key,
      expired: '2099-01-01T00:00:00Z',
    });
    added++;
  }
  console.log(`new: ${added} | already pooled: ${skipped}`);

  if (added > 0) {
    const res = await sql`update provider set credentials_enc = ${encrypt(cred)} where id = ${PROVIDER_ID}`;
    // An UPDATE matching no rows succeeds: assert the write landed.
    if (res.count !== 1) { console.error(`persist matched ${res.count} rows (expected 1)`); process.exit(1); }
    console.log(`pool now holds ${cred.accounts.length} keys`);
  } else {
    console.log('nothing new — pool unchanged');
  }
  console.log('✅ merge done.');
} finally {
  await sql.end();
}
