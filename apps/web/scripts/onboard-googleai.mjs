#!/usr/bin/env node
// Onboard Google AI Studio (Gemini) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-googleai.mjs [keys.txt]
//
// Keys are `email|AIzaSy...` or `email|AQ.Ab8...` pairs — Google issues both
// formats now and both authenticate. We hit the [OI]-compatibility layer
// (/v1beta/openai) so the router can treat Gemini like any other provider.
//
// Only the flash-tier models answer 200 on a free key: the pro models are
// 429/404 for accounts without billing, so they are deliberately left out.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_FILE = process.argv[2] || '/home/dwizzy/kira/googleai_keys.txt';
const PROVIDER_ID = 'googleai';
const PROVIDER_NAME = 'Google AI Studio';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

const rows = readFileSync(KEY_FILE, 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const p = l.split('|'); return { email: p[0], api_key: p[1] }; })
  .filter((r) => r.api_key && (r.api_key.startsWith('AIza') || r.api_key.startsWith('AQ.')));

console.log(`file rows: ${rows.length}`);
if (!rows.length) { console.error('no usable Gemini keys'); process.exit(1); }

const accounts = rows.map((r) => ({
  email: r.email,
  api_key: r.api_key,
  refresh_token: null,
  access_token: r.api_key,
  expired: '2099-01-01T00:00:00Z',
}));

const cred = { api_key: rows[0].api_key, auth_kind: 'apikey', default_headers: {}, accounts };

// slug -> [display name, context]
const MODELS = {
  'gemini-3.6-flash': ['Gemini 3.6 Flash', 1048576],
  'gemini-3.5-flash': ['Gemini 3.5 Flash', 1048576],
  'gemini-3.5-flash-lite': ['Gemini 3.5 Flash Lite', 1048576],
  'gemini-3-flash-preview': ['Gemini 3 Flash Preview', 1048576],
  'gemini-3.1-flash-lite': ['Gemini 3.1 Flash Lite', 1048576],
  'gemini-flash-latest': ['Gemini Flash Latest', 1048576],
  'gemini-flash-lite-latest': ['Gemini Flash Lite Latest', 1048576],
};

try {
  await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, 'active', 190)
    on conflict (id) do update set
      name = excluded.name, base_url = excluded.base_url,
      credentials_enc = excluded.credentials_enc,
      status = excluded.status, priority = excluded.priority
  `;
  console.log(`provider ${PROVIDER_ID} upserted with ${accounts.length} keys`);

  for (const [slug, [name, ctx]] of Object.entries(MODELS)) {
    await sql`
      insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
      values (${randomUUID()}, ${PROVIDER_ID}, ${name}, ${slug}, ${ctx}, 0, 0, 'USD', 'active')
      on conflict (slug) do update set
        provider_id = excluded.provider_id, name = excluded.name,
        context = excluded.context, input_price = 0, output_price = 0, status = 'active'
    `;
  }
  console.log(`${Object.keys(MODELS).length} models upserted`);
  console.log('\n✅ Google AI Studio onboarded. Restart router to load pool.');
} finally {
  await sql.end();
}
