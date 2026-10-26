#!/usr/bin/env node
// ops/onboard-inception.mjs — onboard Inception Labs (Mercury dLLM) into fudrouter.
//
// Plain [OI]-compatible provider: the Go data plane already does the default
// passthrough (POST {base_url}/chat/completions + Bearer), so no engine patch
// and no binary rebuild — this is pure DB work.
//
// Catalog is fetched LIVE from the public GET /v1/models (no auth needed there;
// only the chat path authenticates). Only chat-capable slugs are seeded —
// mercury-decide advertises supported_endpoints=["decisions"] and would 400 on
// the chat path, so it is skipped with a note.
//
// Usage:
//   set -a && . .env && set +a
//   INCEPTION_API_KEY=il_... node ops/onboard-inception.mjs [--dry-run]
//   INCEPTION_API_KEY_FILE=/path/keys.txt node ops/onboard-inception.mjs
//
// Knobs:
//   INCEPTION_API_KEY        single key (or first line of the key file)
//   INCEPTION_API_KEY_FILE   one key per line → multi-key pool
//   INCEPTION_PROVIDER_STATUS  active|dev|disabled (operator-owned; preserved
//                            on re-run unless explicitly set — see provider-status.ts)
//   INCEPTION_PRIORITY       provider priority (default 168)
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');
const BASE_URL = 'https://api.inceptionlabs.ai/v1';
const PROVIDER_ID = 'prv_inception';
const CONNECTION_ID = 'con_prv_inception-default';
const PROVIDER_NAME = 'Inception Labs';
const PRIORITY = Number(process.env.INCEPTION_PRIORITY ?? 168);

// ---------------------------------------------------------------- keys
function loadKeys() {
  const file = process.env.INCEPTION_API_KEY_FILE;
  let keys = [];
  if (file && existsSync(file)) {
    keys = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }
  const single = process.env.INCEPTION_API_KEY;
  if (single) keys.unshift(single.trim());
  keys = [...new Set(keys.filter(Boolean))];
  if (keys.length === 0) {
    throw new Error('no key: set INCEPTION_API_KEY or INCEPTION_API_KEY_FILE');
  }
  return keys;
}

const credId = (key) => 'cred_inception_' + createHash('sha256').update(key).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- crypto (same shape as onboard-mingles)
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

// ---------------------------------------------------------------- upstream
async function fetchModels() {
  const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
  const data = await res.json();
  return data.data ?? [];
}

// A key that answers /v1/models proves nothing (that endpoint is public) —
// validity is only proven by a real chat call.
async function probeKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-2.5', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000)
    });
    return { ok: res.status === 200, status: res.status, body: res.status === 200 ? '' : (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, body: String(e.message ?? e) };
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });

  try {
    const keys = loadKeys();
    console.log(`keys: ${keys.length}`);

    // 1. live catalog
    const upstream = await fetchModels();
    console.log(`upstream advertises ${upstream.length} models`);
    const chatModels = upstream.filter((m) => (m.supported_endpoints ?? []).includes('chat.completions'));
    const skipped = upstream.filter((m) => !(m.supported_endpoints ?? []).includes('chat.completions'));
    for (const m of skipped) console.log(`  skip ${m.id}: endpoints=${JSON.stringify(m.supported_endpoints)} (not chat)`);
    if (chatModels.length === 0) throw new Error('no chat-capable models upstream');

    // 2. prove at least one key with a real chat call
    const probes = [];
    for (const k of keys) probes.push({ key: k, ...(await probeKey(k)) });
    const live = probes.filter((p) => p.ok);
    const dead = probes.filter((p) => !p.ok);
    console.log(`live keys: ${live.length}  dead: ${dead.length}`);
    for (const d of dead) console.log(`  dead key …${d.key.slice(-4)}: HTTP ${d.status} ${d.body}`);
    if (live.length === 0) throw new Error('every key failed a real chat call — nothing to onboard');

    // 3. slug owner-guard (model.slug is UNIQUE table-wide)
    const owned = new Map();
    for (const m of chatModels) {
      const [row] = await sql`select provider_id from model where slug = ${m.id}`;
      if (row) owned.set(m.id, row.provider_id);
    }
    const seedable = chatModels.filter((m) => !owned.has(m.id));
    for (const m of chatModels.filter((m) => owned.has(m.id))) {
      console.log(`  skip slug ${m.id}: already owned by ${owned.get(m.id)}`);
    }
    if (seedable.length === 0) throw new Error('every chat slug is owned by another provider');

    if (DRY) {
      console.log('--dry-run: no writes');
      console.log(`would seed: ${seedable.map((m) => m.id).join(', ')}`);
      return;
    }

    // 4. status resolution (operator-owned; preserved unless explicitly set)
    const explicit = ['1', 'true', 'yes', 'on'].includes(String(process.env.INCEPTION_PROVIDER_STATUS ?? '').toLowerCase())
      ? process.env.INCEPTION_PROVIDER_STATUS
      : null;
    const status = explicit ?? 'active';
    if (!['active', 'dev', 'disabled'].includes(status)) throw new Error(`bad status: ${status}`);

    await sql.begin(async (tx) => {
      // provider
      const legacyBlob = encryptJson({
        api_key: live[0].key,
        auth_kind: 'apikey',
        default_headers: {},
        accounts: live.map((p, i) => ({
          email: `inception-key-${i + 1}@inceptionlabs.ai`,
          api_key: p.key,
          access_token: p.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z' // far-future: pool never tries to refresh a static key
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

      // connection
      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, priority, enabled, config)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, ${PROVIDER_NAME}, 'default', ${BASE_URL}, 'bearer', ${PRIORITY}, true,
                ${tx.json({ auth_kind: 'apikey', default_headers: {} })}
        on conflict (id) do update set
          base_url = excluded.base_url, enabled = true, updated_at = now()`;

      // credentials (one row per live key; deterministic id = idempotent)
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

      // dead keys that were previously imported → park them
      let invalidated = 0;
      for (const d of dead) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${credId(d.key)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      if (invalidated > 0) console.log(`marked invalid: ${invalidated}`);

      // models + provider_models
      let seeded = 0;
      for (const m of seedable) {
        const modelId = randomUUID();
        // upstream pricing is per-token as a string; store micro-USD per 1M
        const inMicro = Math.round(Number(m.pricing?.prompt ?? 0) * 1e6);
        const outMicro = Math.round(Number(m.pricing?.completion ?? 0) * 1e6);
        await tx`
          insert into model (id, provider_id, name, slug, context, max_output, input_price, output_price,
                             family, developer, description, modality, capabilities, status)
          values (${modelId}, ${PROVIDER_ID}, ${m.name ?? m.id}, ${m.id}, ${m.context_length ?? null},
                  ${m.max_output_length ?? null}, ${inMicro}, ${outMicro},
                  'mercury', 'inceptionlabs', ${m.description ?? ''},
                  ${tx.json({ input: m.input_modalities ?? ['text'], output: m.output_modalities ?? ['text'] })},
                  ${tx.json({ features: m.supported_features ?? [], sampling: m.supported_sampling_parameters ?? [] })},
                  'active')
          on conflict (slug) do update set
            name = excluded.name, context = excluded.context, max_output = excluded.max_output,
            input_price = excluded.input_price, output_price = excluded.output_price,
            description = excluded.description, updated_at = now()`;
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pmdl_' + modelId}, ${modelId}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.id}, true, 'available')
          on conflict (id) do update set enabled = true, status = 'available', updated_at = now()`;
        seeded += 1;
        console.log(`  seeded ${m.id} (ctx ${m.context_length}, $${(inMicro / 1e6).toFixed(2)}/$${(outMicro / 1e6).toFixed(2)} per 1M)`);
      }
      console.log(`models seeded: ${seeded} (provider status: ${status}${explicit ? ' [explicit]' : ' [preserved/default]'})`);
    });

    const [cc] = await sql`
      select count(*)::int n from credential cr join connection cn on cn.id = cr.connection_id
      where cn.provider_id = ${PROVIDER_ID}`;
    const [mm] = await sql`select count(*)::int n from model where provider_id = ${PROVIDER_ID} and status = 'active'`;
    console.log(`pool now: ${cc.n} credentials, ${mm.n} active models`);
    console.log('verify with: curl -s http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer $KEY" \\');
    console.log('  -d \'{"model":"mercury-2.5","messages":[{"role":"user","content":"hi"}],"max_tokens":5}\'');
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
