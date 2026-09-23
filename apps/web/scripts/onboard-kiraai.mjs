#!/usr/bin/env node
// Onboard KiraAI (kiraai.vn) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-kiraai.mjs [keys.txt]
//
// Keys are `email|kira_<hex>` pairs. They are static bearer keys with no refresh,
// so they get the far-future expiry the router uses for non-refreshable creds.
//
// Only the `kira-*` first-party models are reachable on the free tier; every
// partner model (deepseek/grok/kimi/...) returns 402 vnd_balance_exhausted
// because the wallet is 0 VND. So we expose exactly the kira-* chat models that
// answered 200 on the free allowance.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_FILE = process.argv[2] || '/home/dwizzy/kira/kira_keys.txt';
const PROVIDER_ID = 'kiraai';
const PROVIDER_NAME = 'KiraAI';
const BASE_URL = 'https://kiraai.vn/api/v1';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

const rows = readFileSync(KEY_FILE, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const p = l.split('|');
    return { email: p[0], api_key: p[1] };
  })
  .filter((r) => r.api_key && r.api_key.startsWith('kira_'));

console.log(`file rows: ${rows.length}`);
if (!rows.length) {
  console.error('no usable kira_ keys — nothing to onboard');
  process.exit(1);
}

const accounts = rows.map((r) => ({
  email: r.email,
  api_key: r.api_key,
  refresh_token: null,               // static key, no refresh
  access_token: r.api_key,
  expired: '2099-01-01T00:00:00Z',
}));

const cred = { api_key: rows[0].api_key, auth_kind: 'apikey', default_headers: {}, accounts };

// slug -> [display name, context window] ; all zero-cost on the free allowance
const MODELS = {
  'kira-3.5-pro': ['Kira 3.5 Pro', 128000],
  'kira-3.5-flash': ['Kira 3.5 Flash', 128000],
  'kira-2.5-pro': ['Kira 2.5 Pro', 128000],
  'kira-2.5-flash': ['Kira 2.5 Flash', 128000],
  'kira-flash': ['Kira Flash', 153600],
  'kira-mini-1.0': ['Kira Mini 1.0', 128000],
  'kira-3.0-image': ['Kira 3.0 Image', 128000],
  'kira-2.0-image': ['Kira 2.0 Image', 128000],
};

try {
  await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, 'dev', 170)
    on conflict (id) do update set
      name = excluded.name,
      base_url = excluded.base_url,
      credentials_enc = excluded.credentials_enc,
      status = excluded.status,
      priority = excluded.priority
  `;
  console.log(`provider ${PROVIDER_ID} upserted with ${accounts.length} keys`);

  for (const [slug, [name, ctx]] of Object.entries(MODELS)) {
    await sql`
      insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
      values (${randomUUID()}, ${PROVIDER_ID}, ${name}, ${slug}, ${ctx}, 0, 0, 'USD', 'active')
      on conflict (slug) do update set
        provider_id = excluded.provider_id,
        name = excluded.name,
        context = excluded.context,
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        status = excluded.status
    `;
  }
  console.log(`${Object.keys(MODELS).length} models upserted`);
  console.log('\n✅ KiraAI onboarded. Restart router to load pool.');
} finally {
  await sql.end();
}
