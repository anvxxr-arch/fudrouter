#!/usr/bin/env node
// ops/onboard-tokenjuice.mjs — onboard Token Juice (free DeepSeek-V4.1-Flash preview) into fudrouter.
//
// Farm: /home/dwizzy/farm/tokenjuice-farmer/tokenjuice_farmer.py writes
// data/tj_keys.txt as "email|tj_key|status" lines (one line per account).
// This script reads live keys, probes each with a real chat call, seeds
// provider/connection/credentials/models, and rebuilds the legacy blob.
//
// Usage:
//   set -a && . .env && set +a
//   node ops/onboard-tokenjuice.mjs [--dry-run]
//   TOKENJUICE_KEY_FILE=/path/tj_keys.txt node ops/onboard-tokenjuice.mjs
//
// Idempotent: credential id = cred_tokenjuice_<sha256(key)[:16]>, provider/connection
// upserted, provider.status preserved across re-runs unless TOKENJUICE_PROVIDER_STATUS set.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');
const BASE_URL = 'https://api.tokenjuice.ai/v1';
const PROVIDER_ID = 'prv_tokenjuice';
const CONNECTION_ID = 'con_prv_tokenjuice-default';
const PROVIDER_NAME = 'Token Juice';
const PRIORITY = Number(process.env.TOKENJUICE_PRIORITY ?? 165);
const DEFAULT_FILE = '/home/dwizzy/farm/tokenjuice-farmer/data/tj_keys.txt';

function loadKeys() {
  const file = process.env.TOKENJUICE_KEY_FILE ?? DEFAULT_FILE;
  const keys = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([^|]+@[^|]+)\|(tj_[A-Za-z0-9_-]{6,})\|/.exec(line.trim());
    if (m) keys.push({ email: m[1], key: m[2] });
    else if (line.trim() && !line.startsWith('#')) {
      // tolerate bare tj_ keys without the email prefix
      const k = /(tj_[A-Za-z0-9_-]{6,})/.exec(line.trim());
      if (k) keys.push({ email: '', key: k[1] });
    }
  }
  const seen = new Set();
  return keys.filter((k) => (seen.has(k.key) ? false : (seen.add(k.key), true)));
}

const credId = (key) => 'cred_tokenjuice_' + createHash('sha256').update(key).digest('hex').slice(0, 16);

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

async function fetchModels(key) {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  const data = await res.json();
  return data.data ?? [];
}

const UPSTREAM = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
async function probeKey(key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: UPSTREAM, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(90_000)
      });
      if (res.status === 200) return { ok: true, status: 200, body: '' };
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 3000)); continue; }
      return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
    } catch (e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
      else return { ok: false, status: 0, body: String(e.message ?? e) };
    }
  }
  return { ok: false, status: 0, body: 'timeout after 2 attempts' };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const keys = loadKeys();
    console.log(`keys: ${keys.length} from ${process.env.TOKENJUICE_KEY_FILE ?? DEFAULT_FILE}`);
    if (keys.length === 0) throw new Error('no tj_ keys parsed');

    const upstream = await fetchModels(keys[0].key);
    console.log(`upstream advertises ${upstream.length} models: ${upstream.map((m) => m.id).join(', ')}`);

    const verdicts = await mapLimit(keys, Number(process.env.TOKENJUICE_PROBE_CONCURRENCY ?? 6),
      (k) => probeKey(k.key));
    const probes = keys.map((k, i) => ({ key: k.key, email: k.email, ...verdicts[i] }));
    const live = probes.filter((p) => p.ok);
    const dead = probes.filter((p) => !p.ok);
    console.log(`live keys: ${live.length}  dead: ${dead.length}`);
    for (const d of dead) console.log(`  dead key ...${d.key.slice(-4)}: HTTP ${d.status} ${d.body}`);
    if (live.length === 0) throw new Error('every key failed a real chat call - nothing to onboard');

    const explicit = ['1', 'true', 'yes', 'on'].includes(String(process.env.TOKENJUICE_PROVIDER_STATUS ?? '').toLowerCase())
      ? process.env.TOKENJUICE_PROVIDER_STATUS
      : null;
    const status = explicit ?? 'active';
    if (!['active', 'dev', 'disabled'].includes(status)) throw new Error(`bad status: ${status}`);

    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    await sql.begin(async (tx) => {
      const legacyBlob = encryptJson({
        api_key: live[0].key,
        auth_kind: 'apikey',
        default_headers: {},
        accounts: live.map((p, i) => ({
          email: p.email || `tokenjuice-key-${i + 1}@grabmail.io`,
          api_key: p.key,
          access_token: p.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z'
        }))
      });
      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, priority, type, tier)
        values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${legacyBlob}, ${status}, ${PRIORITY}, 'openai_compatible', 'commercial')
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
        on conflict (id) do update set
          base_url = excluded.base_url, enabled = true, updated_at = now()`;

      let newCreds = 0;
      for (const p of live) {
        const id = credId(p.key);
        const secret = encryptJson({ api_key: p.key, email: p.email });
        // status 'healthy': this key already passed a real chat call in this run.
        // poolrebuild only carries credential rows with status='healthy' into the
        // provider blob, so leaving new rows 'unknown' silently drops them.
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${id}, ${CONNECTION_ID}, ${p.email || id}, ${secret}, 'healthy', ${tx.json(p.email ? { email: p.email } : {})})
          on conflict (id) do update set secret_enc = excluded.secret_enc, status = 'healthy', updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
      }
      console.log(`credentials: ${newCreds} new, ${live.length - newCreds} refreshed`);
      let invalidated = 0;
      for (const d of dead) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${credId(d.key)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      if (invalidated > 0) console.log(`marked invalid: ${invalidated}`);

      // Models: use tidy fudrouter slugs <provider>/<short>; upstream id stays in provider_model_id.
      const slugMap = {
        [UPSTREAM]: 'tokenjuice/deepseek-v4.1-flash'
      };
      for (const m of upstream) {
        const slug = slugMap[m.id];
        if (!slug) continue;
        const ctx = m.context_window ?? null;
        // NOTE: on conflict the update path returns the EXISTING row id, so the
        // provider_model insert must use that returned id — not the fresh UUID
        // (a fresh UUID is not in the table and violates the FK).
        const [mrow] = await tx`
          insert into model (id, provider_id, name, slug, context, max_output, input_price, output_price,
                             family, developer, description, modality, capabilities, status)
          values (${randomUUID()}, ${PROVIDER_ID}, ${slug}, ${slug}, ${ctx}, null, 0, 0,
                  'deepseek', 'tokenjuice', ${m.id} || ' (free preview)',
                  ${tx.json({ input: ['text'], output: ['text'] })}, ${tx.json({ features: ['chat'] })}, 'active')
          on conflict (slug) do update set
            name = excluded.name, context = excluded.context, input_price = excluded.input_price,
            output_price = excluded.output_price, status = 'active', updated_at = now()
          returning id`;
        const mid = mrow.id;
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pmdl_' + mid}, ${mid}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.id}, true, 'available')
          on conflict (id) do update set enabled = true, status = 'available', updated_at = now()`;
        console.log(`  seeded ${slug} -> upstream ${m.id} (ctx ${ctx})`);
      }
    });

    const [cc] = await sql`select count(*)::int n from credential cr join connection cn on cn.id = cr.connection_id where cn.provider_id = ${PROVIDER_ID}`;
    const [mm] = await sql`select count(*)::int n from model where provider_id = ${PROVIDER_ID} and status = 'active'`;
    console.log(`pool now: ${cc.n} credentials, ${mm.n} active models`);
    console.log('next: poolrebuild prv_tokenjuice && pm2 restart fudrouter-router');
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
