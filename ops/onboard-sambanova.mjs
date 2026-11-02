#!/usr/bin/env node
// ops/onboard-sambanova.mjs — onboard SambaNova into fudrouter.
//
// Plain [OI]-compatible provider: passthrough POST {base}/chat/completions + Bearer.
// Catalog fetched LIVE from GET /v1/models. Unlike Inception, SambaNova's model
// records carry no supported_endpoints (all are chat-capable), so no filter.
//
// NOTE on the free tier: SambaNova's LPU is perennially saturated, so a valid key
// frequently returns 429 "model ... currently experiencing high demand" on every
// model. A 429 here is NOT auth-death (that's 401/403) — the key is authenticated
// but throttled. We treat 429 as "valid-but-throttled": the credential is onboarded
// and the router's cooldown machinery naturally backs off & retries when LPU frees.
//
// Usage:
//   set -a && . .env && set +a
//   SAMBANOVA_API_KEY="..." node ops/onboard-sambanova.mjs [--dry-run]
//   SAMBANOVA_API_KEY_FILE=/path/keys.txt node ops/onboard-sambanova.mjs
// Knobs: SAMBANOVA_PRIORITY (default 90), SAMBANOVA_PROVIDER_STATUS
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');
const BASE_URL = 'https://api.sambanova.ai/v1';
const PROVIDER_ID = 'prv_sambanova';
const CONNECTION_ID = 'con_prv_sambanova-default';
const PROVIDER_NAME = 'SambaNova';
const PRIORITY = Number(process.env.SAMBANOVA_PRIORITY ?? 90);

function loadKeys() {
  const file = process.env.SAMBANOVA_API_KEY_FILE;
  let keys = [];
  if (file && existsSync(file)) {
    keys = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  const single = process.env.SAMBANOVA_API_KEY;
  if (single) keys.unshift(single.trim());
  keys = [...new Set(keys.filter(Boolean))];
  if (keys.length === 0) throw new Error('no key: set SAMBANOVA_API_KEY or SAMBANOVA_API_KEY_FILE');
  return keys;
}

const credId = (key) => 'cred_sambanova_' + createHash('sha256').update(key).digest('hex').slice(0, 16);

const masterKey = () => {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
  return buf;
};
const encryptJson = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};

async function fetchModels() {
  const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.id,
    context: m.context_length ?? null,
    max_output: m.max_completion_tokens ?? null,
    in: Math.round(Number(m.pricing?.prompt ?? 0) * 1e6),
    out: Math.round(Number(m.pricing?.completion ?? 0) * 1e6)
  }));
}

// 200 = serving; 429 = authenticated but throttled (free-tier saturation) → still
// onboard (router cooldown handles it). 401/403 = dead key.
async function probeKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V3.1', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000)
    });
    const body = res.status === 200 ? '' : (await res.text()).slice(0, 200);
    if (res.status === 200) return { ok: true, status: 200, body };
    if (res.status === 429 || res.status === 503) return { ok: true, throttled: true, status: res.status, body };
    return { ok: false, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e.message ?? e) };
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });

  try {
    const keys = loadKeys();
    console.log(`keys: ${keys.length}`);

    const upstream = await fetchModels();
    console.log(`upstream advertises ${upstream.length} models`);
    const models = upstream.map((m) => ({ ...m, developer: 'sambanova', family: 'sambanova', desc: `${m.id} (SambaNova)` }));
    if (models.length === 0) throw new Error('no models upstream');

    const probes = [];
    for (const k of keys) probes.push({ key: k, ...(await probeKey(k)) });
    // valid = serving OR throttled (authenticated). dead = auth-rejected / network-fail.
    const live = probes.filter((p) => p.ok);
    const dead = probes.filter((p) => !p.ok);
    const throttled = live.filter((p) => p.throttled);
    console.log(`live keys: ${live.length} (${throttled.length} throttled)  dead: ${dead.length}`);
    for (const d of dead) console.log(`  dead key …${d.key.slice(-4)}: HTTP ${d.status} ${d.body}`);
    if (live.length === 0) throw new Error('every key auth-rejected — nothing to onboard');

    const owned = new Map();
    for (const m of models) {
      const [row] = await sql`select provider_id from model where slug = ${m.id}`;
      if (row) owned.set(m.id, row.provider_id);
    }
    const seedable = models.filter((m) => !owned.has(m.id));
    for (const m of models.filter((m) => owned.has(m.id))) console.log(`  skip slug ${m.id}: owned by ${owned.get(m.id)}`);
    if (seedable.length === 0) throw new Error('every slug is owned by another provider');

    if (DRY) {
      console.log('--dry-run: no writes');
      console.log(`would seed: ${seedable.map((m) => m.id).join(', ')}`);
      console.log(`would onboard live keys: ${live.length}`);
      return;
    }

    const explicit = ['1', 'true', 'yes', 'on'].includes(String(process.env.SAMBANOVA_PROVIDER_STATUS ?? '').toLowerCase())
      ? process.env.SAMBANOVA_PROVIDER_STATUS : null;
    const status = explicit ?? 'active';

    await sql.begin(async (tx) => {
      const legacyBlob = encryptJson({
        api_key: live[0].key,
        auth_kind: 'apikey',
        default_headers: {},
        accounts: live.map((p, i) => ({
          email: `sambanova-key-${i + 1}@sambanova.ai`,
          api_key: p.key,
          access_token: p.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z'
        }))
      });

      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, priority)
        values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${legacyBlob}, ${status}, ${PRIORITY})
        on conflict (id) do update set
          base_url = excluded.base_url,
          credentials_enc = excluded.credentials_enc,
          priority = excluded.priority,
          ${explicit ? tx`status = excluded.status,` : tx`status = provider.status,`}
          updated_at = now()`;

      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, priority, enabled, config)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, ${PROVIDER_NAME}, 'default', ${BASE_URL}, 'bearer', ${PRIORITY}, true,
                ${tx.json({ auth_kind: 'apikey', default_headers: {} })})
        on conflict (id) do update set base_url = excluded.base_url, enabled = true, updated_at = now()`;

      let newCreds = 0;
      for (const p of live) {
        const id = credId(p.key);
        const secret = encryptJson({ api_key: p.key });
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status)
          values (${id}, ${CONNECTION_ID}, ${id}, ${secret}, 'unknown')
          on conflict (id) do update set secret_enc = excluded.secret_enc, updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
      }
      console.log(`credentials: ${newCreds} new, ${live.length - newCreds} refreshed`);

      for (const d of dead) {
        await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${credId(d.key)} and status <> 'invalid'`;
      }

      let seeded = 0;
      for (const m of seedable) {
        const modelId = randomUUID();
        await tx`
          insert into model (id, provider_id, name, slug, context, max_output, input_price, output_price,
                             family, developer, description, status)
          values (${modelId}, ${PROVIDER_ID}, ${m.name}, ${m.id}, ${m.context}, ${m.max_output},
                  ${m.in}, ${m.out}, ${m.family}, ${m.developer}, ${m.desc}, 'active')
          on conflict (slug) do update set
            name = excluded.name, context = excluded.context, max_output = excluded.max_output,
            input_price = excluded.input_price, output_price = excluded.output_price, updated_at = now()`;
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pmdl_' + modelId}, ${modelId}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.id}, true, 'available')
          on conflict (id) do update set enabled = true, status = 'available', updated_at = now()`;
        seeded += 1;
        console.log(`  seeded ${m.id} (ctx ${m.context})`);
      }
      console.log(`models seeded: ${seeded} (provider status: ${status})`);
    });

    const [cc] = await sql`select count(*)::int n from credential cr join connection cn on cn.id = cr.connection_id where cn.provider_id = ${PROVIDER_ID}`;
    const [mm] = await sql`select count(*)::int n from model where provider_id = ${PROVIDER_ID} and status = 'active'`;
    console.log(`pool now: ${cc.n} credentials, ${mm.n} active models`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });