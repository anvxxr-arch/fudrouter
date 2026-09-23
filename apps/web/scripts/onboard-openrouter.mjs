#!/usr/bin/env node
// Onboard OpenRouter to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-openrouter.mjs [keys.txt]
//
// Keys are `email|sk-or-v1-...` pairs. All accounts are on the free tier with
// the spend limit already consumed, so only the `:free` variants are reachable.
// We register exactly the free models that answered 200 during the sweep —
// several others are 429 (upstream saturated) or gated behind an agentic
// harness and would just fail at request time.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_FILE = process.argv[2] || '/home/dwizzy/kira/openrouter_keys.txt';
const PROVIDER_ID = 'openrouter';
const PROVIDER_NAME = 'OpenRouter';
const BASE_URL = 'https://openrouter.ai/api/v1';

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
  .filter((r) => r.api_key && r.api_key.startsWith('sk-or-v1-'));

console.log(`file rows: ${rows.length}`);
if (!rows.length) { console.error('no usable sk-or-v1- keys'); process.exit(1); }

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
  'nex-agi/nex-n2.5-pro:free': ['Nex-N2.5-Pro (free)', 262144],
  'nex-agi/nex-n2.5-mini:free': ['Nex-N2.5-Mini (free)', 262144],
  'nvidia/nemotron-3-super-120b-a12b:free': ['Nemotron 3 Super 120B (free)', 262144],
  'nvidia/nemotron-3.5-lightning:free': ['Nemotron 3.5 Lightning (free)', 1000000],
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': ['Nemotron 3 Nano Omni (free)', 256000],
  'nvidia/nemotron-3.5-content-safety:free': ['Nemotron 3.5 Content Safety (free)', 128000],
  'cohere/north-mini-code:free': ['Cohere North Mini Code (free)', 256000],
  'poolside/laguna-xs-2.1:free': ['Laguna XS 2.1 (free)', 262144],
  'liquid/lfm-2.5-2.6b:free': ['LFM2.5-2.6B (free)', 65536],
  'dots-studio/dots-3-note-preview:free': ['Dots3 Note Preview (free)', 512000],
  'inclusionai/ling-3.0-flash-vl:free': ['Ling 3.0 Flash VL (free)', 262144],
  'inclusionai/ling-3.0-flash-sante:free': ['Ling 3.0 Flash Sante (free)', 262144],
  'inclusionai/ling-3.0-flash-fin:free': ['Ling 3.0 Flash Fin (free)', 262144],
};

try {
  await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, 'dev', 180)
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
  console.log('\n✅ OpenRouter onboarded. Restart router to load pool.');
} finally {
  await sql.end();
}
