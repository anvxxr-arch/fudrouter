#!/usr/bin/env node
// Onboard UniKey to fudrouter: 48 API keys, OpenAI-compatible, no refresh needed.
// Usage: node --env-file=apps/web/.env scripts/onboard-unikey.mjs
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';

const KEY_FILE = '/home/dwizzy/.hermes/cache/documents/doc_99ebe3069425_unikey_tuyul_keys.txt';
const PROVIDER_ID = 'unikey';
const PROVIDER_NAME = 'UniKey';
const BASE_URL = 'https://www.getunikey.ai/v1';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(obj);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

try {
  // Read keys
  const keys = (await import('node:fs')).readFileSync(KEY_FILE, 'utf8')
    .split('\n').filter(l => l.trim().startsWith('sk-')).map(l => l.trim());
  console.log(`loaded ${keys.length} keys`);

  // Build credential blob: static API keys (no refresh)
  const accounts = keys.map((k, i) => ({
    email: `unikey-key-${i + 1}@getunikey.ai`,
    api_key: k,
    refresh_token: null, // static key, no refresh
    access_token: k,
    expired: '2099-01-01T00:00:00Z', // far future, never refresh
  }));

  const cred = {
    api_key: keys[0], // fallback
    auth_kind: 'apikey',
    default_headers: {},
    accounts,
  };

  const enc = encrypt(cred);

  // Upsert provider
  await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${enc}, 'dev', 150)
    on conflict (id) do update set
      name = excluded.name,
      base_url = excluded.base_url,
      credentials_enc = excluded.credentials_enc,
      status = excluded.status,
      priority = excluded.priority
  `;
  console.log(`provider ${PROVIDER_ID} upserted`);

  // Upsert models (from UniKey catalog)
  const models = [
    { slug: 'grok-4.3', name: 'Grok 4.3', input: 2.00, output: 6.00, context: 500000 },
    { slug: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: 0.27, output: 1.00, context: 128000 },
    { slug: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: 0.07, output: 0.27, context: 128000 },
    { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', input: 0.80, output: 4.00, context: 200000 },
    { slug: 'claude-opus-4-6', name: 'Claude Opus 4.6', input: 15.00, output: 75.00, context: 200000 },
    { slug: 'claude-opus-4-7', name: 'Claude Opus 4.7', input: 15.00, output: 75.00, context: 200000 },
    { slug: 'gpt-5.5', name: 'GPT-5.5', input: 1.25, output: 10.00, context: 128000 },
    { slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: 1.25, output: 10.00, context: 128000 },
    { slug: 'gpt-6-astra', name: 'GPT-6 Astra', input: 1.25, output: 10.00, context: 128000 },
    { slug: 'qwen3.7-max', name: 'Qwen3.7 Max', input: 0.27, output: 1.00, context: 128000 },
    { slug: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', input: 0.10, output: 0.40, context: 1000000 },
    { slug: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', input: 1.25, output: 5.00, context: 1000000 },
    { slug: 'kimi-k3', name: 'Kimi K3', input: 0.27, output: 1.00, context: 128000 },
    { slug: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', input: 0.27, output: 1.00, context: 128000 },
  ];

  for (const m of models) {
    await sql`
      insert into model (id, slug, name, provider_id, input_price, output_price, context)
      values (${crypto.randomUUID()}, ${m.slug}, ${m.name}, ${PROVIDER_ID}, ${m.input}, ${m.output}, ${m.context})
      on conflict (slug) do update set
        name = excluded.name,
        provider_id = excluded.provider_id,
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        context = excluded.context
    `;
  }
  console.log(`${models.length} models upserted`);

  console.log('\n✅ UniKey onboarded. Restart router to load pool.');
} finally {
  await sql.end();
}
