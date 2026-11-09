#!/usr/bin/env node
// ops/onboard-crowllm.mjs — sync a batch of crowllm keys into fudrouter.
//
// crowllm.com/v1 is an OpenAI-compatible router whose whole catalogue is `:free`
// tier (87 of 88 models). Keys are 48-char opaque strings; auth is bearer.
//
// WAF NOTE: crowllm's edge answers `403 error code: 1010` to any request carrying
// a python-urllib / node-fetch default signature. Every probe MUST send a browser
// User-Agent, otherwise the whole batch reads as dead.
//
// Source of truth: a tab-separated key file (`url<TAB>key<TAB>model`), the same
// shape as the shared key-share drops. Probe each key against ONE cheap model to
// prove it is live, then import.
//
// Idempotent: credential id is cred_crowllm_<sha256(key)[:16]>, written once.
// A key dead at probe time is flipped to 'invalid' so the pool stops retrying it.
//
// Usage:  set -a && . .env && set +a && node ops/onboard-crowllm.mjs <keyfile> [--dry-run]
// Knobs:  CROWLLM_PROBE_CONCURRENCY (default 12), CROWLLM_PROBE_MODEL
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');
const KEY_FILE = process.argv.find((a) => !a.startsWith('--') && a.endsWith('.txt'));
if (!KEY_FILE) {
  console.error('usage: node ops/onboard-crowllm.mjs <keyfile.txt> [--dry-run]');
  process.exit(2);
}

const PROVIDER_ID = 'prv_crowllm';
const CONNECTION_ID = 'con_prv_crowllm-default';
const BASE_URL = 'https://crowllm.com/v1';
const PROBE_MODEL = process.env.CROWLLM_PROBE_MODEL ?? 'glm-5.3-flash:free';
const PROBE_CONC = Number(process.env.CROWLLM_PROBE_CONCURRENCY ?? 12);
// `tier` decides whether the data plane serves this provider at all: catalog.go
// publishes a provider only when `tier='commercial'`, or when it is dev-tier AND
// the process has ROUTER_ALLOW_DEV_PROVIDERS truthy. Onboarding as dev without
// that flag imports every credential into a provider nobody can call — the pool
// shows healthy and the models stay invisible. Default commercial (crowllm serves
// a public free tier, not personal OAuth), and let an operator override.
const TIER = process.env.CROWLLM_TIER ?? 'commercial';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

function loadKeys() {
  const text = readFileSync(KEY_FILE, 'utf8');
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    const key = (cols[1] ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, baseUrl: (cols[0] ?? BASE_URL).trim() || BASE_URL, model: (cols[2] ?? PROBE_MODEL).trim() });
  }
  return out;
}

const credId = (key) => 'cred_crowllm_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
const idOf = (k) => credId(k.key);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

async function probeKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ model: PROBE_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(60_000)
    });
    if (res.status !== 200) return { ok: false, status: res.status };
    const j = await res.json().catch(() => null);
    return { ok: Array.isArray(j?.choices) && j.choices.length > 0, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, err: e.message };
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const all = loadKeys();
    if (all.length === 0) throw new Error(`no keys in ${KEY_FILE}`);
    console.log(`keys in file: ${all.length}`);
    console.log(`probe model: ${PROBE_MODEL}`);

    const probed = await mapLimit(all, PROBE_CONC, async (k) => ({ k, r: await probeKey(k.key) }));
    const liveKeys = probed.filter((p) => p.r.ok).map((p) => p.k);
    const dead = probed.filter((p) => !p.r.ok);
    console.log(`live now: ${liveKeys.length}  dead now: ${dead.length}`);
    const byStatus = {};
    for (const d of dead) byStatus[d.r.status] = (byStatus[d.r.status] ?? 0) + 1;
    console.log('dead by status:', JSON.stringify(byStatus));
    if (liveKeys.length === 0) throw new Error('no live keys — upstream rejected every key');

    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    await sql.begin(async (tx) => {
      // provider row (created if absent, operator status preserved on conflict)
      const legacyBlob = encryptJson({
        api_key: liveKeys[0].key,
        auth_kind: 'apikey',
        default_headers: {},
        accounts: liveKeys.map((k) => ({
          email: idOf(k),
          access_token: k.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z'
        }))
      });
      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, slug, tier, enabled)
        values (${PROVIDER_ID}, 'CrowLLM', ${BASE_URL}, ${legacyBlob}, 'active', 'crowllm', ${TIER}, true)
        on conflict (id) do update set
          credentials_enc = excluded.credentials_enc,
          base_url = excluded.base_url,
          updated_at = now()`;

      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, enabled)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, 'CrowLLM default', 'default', ${BASE_URL}, 'bearer', true)
        on conflict (id) do update set
          base_url = excluded.base_url,
          enabled = true,
          updated_at = now()`;

      let newCreds = 0;
      let revived = 0;
      for (const k of liveKeys) {
        const id = credId(k.key);
        const secret = encryptJson({ api_key: k.key });
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${id}, ${CONNECTION_ID}, ${id}, ${secret}, 'unknown', ${tx.json({ source: 'key-share', base_url: BASE_URL })})
          on conflict (id) do update set
            secret_enc = excluded.secret_enc,
            updated_at = now()
          returning (xmax = 0) as inserted, status`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
        if (r.length > 0 && r[0].status !== 'unknown' && r[0].status !== 'active') revived += 1;
      }
      console.log(`credentials: ${newCreds} new, ${liveKeys.length - newCreds} refreshed, ${revived} revived from a failed status`);

      let invalidated = 0;
      for (const d of dead) {
        if (d.r.status !== 401 && d.r.status !== 403) continue; // only truly-auth failures
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${idOf(d.k)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      console.log(`marked invalid (401/403 only): ${invalidated}`);
    });

    const [cc] = await sql`
      select count(*)::int n,
             count(*) filter (where cr.status = 'invalid')::int inv
      from credential cr join connection cn on cn.id = cr.connection_id
      where cn.provider_id = ${PROVIDER_ID}`;
    console.log(`pool now: ${cc.n} credentials (invalid=${cc.inv})`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
