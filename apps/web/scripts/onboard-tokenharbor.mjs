#!/usr/bin/env node
// Onboard TokenHarbor to fudrouter: static thk_live_ keys, free model only.
// Usage: node --env-file=apps/web/.env scripts/onboard-tokenharbor.mjs [keys.txt]
//
// The free tier is a per-account consent flag, not a balance, so the only model
// worth exposing is `mimo-v2.5:free`. Keys are static (no refresh), so they get
// the far-future expiry the router uses for non-refreshable credentials.
import postgres from 'postgres';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const KEY_FILE = process.argv[2] || '/home/dwizzy/th-bot/th_keys_direct.txt';
const PROVIDER_ID = 'tokenharbor';
const PROVIDER_NAME = 'TokenHarbor';
const BASE_URL = 'https://tokenharbor.ai/v1';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

// Rows are `email|password|key|verify=..|consent=..|free=..`; older drops are a
// bare key per line. Accept both, and only keep keys that tested free=Y.
const raw = readFileSync(KEY_FILE, 'utf8').split('\n').filter((l) => l.trim());
const rows = raw.map((l) => {
  if (l.includes('|')) {
    const p = l.split('|');
    return { email: p[0], api_key: p[2], free: (p.find((x) => x.startsWith('free=')) || '').split('=')[1] };
  }
  return { email: '', api_key: l.trim(), free: 'Y' };
});
const usable = rows.filter((r) => r.api_key && r.api_key.startsWith('thk_') && r.free !== 'N');

console.log(`file rows: ${rows.length} | usable (free!=N): ${usable.length}`);
if (!usable.length) {
  console.error('no usable keys — nothing to onboard');
  process.exit(1);
}

const accounts = usable.map((r, i) => ({
  email: r.email || `tokenharbor-key-${i + 1}@tokenharbor.ai`,
  api_key: r.api_key,
  refresh_token: null,                 // static key, no refresh
  access_token: r.api_key,
  expired: '2099-01-01T00:00:00Z',     // far future, never refresh
}));

const cred = { api_key: usable[0].api_key, auth_kind: 'apikey', default_headers: {}, accounts };

try {
  await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, 'dev', 160)
    on conflict (id) do update set
      name = excluded.name,
      base_url = excluded.base_url,
      credentials_enc = excluded.credentials_enc,
      status = excluded.status,
      priority = excluded.priority
  `;
  console.log(`provider ${PROVIDER_ID} upserted with ${accounts.length} keys`);

  const models = [
    { slug: 'mimo-v2.5:free', name: 'MiMo v2.5 (free)', input: 0, output: 0, context: 128000 },
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
  console.log(`${models.length} model upserted`);
  console.log('\n✅ TokenHarbor onboarded. Restart router to load pool.');
} finally {
  await sql.end();
}
