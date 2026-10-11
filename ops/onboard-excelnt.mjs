#!/usr/bin/env node
// ops/onboard-excelnt.mjs — onboard excelnt.ai (OpenAI-compatible, static
// `sk_live_` keys minted by the excelnt farm) into fudrouter.
//
// Why a script and not SQL: provider/credential secrets are AES-256-GCM
// ciphertext (`provider.credentials_enc`, `credential.secret_enc`) whose
// envelope only code holding CREDENTIALS_MASTER_KEY can produce — the same
// base64(iv[12] || ct || tag[16]) format as packages/platform/server/credentials.ts
// and backend/go/internal/crypt.
//
// Idempotent by construction (the farm appends keys continuously and REVOKES a
// key when it re-mints for the same account, so this must be safe to re-run at
// any time):
//   * every key is verified against the upstream `/v1/models` first; a dead key
//     is never imported, and a previously-imported key that has since died is
//     flipped to credential.status='invalid' so the pool stops trying it.
//   * provider     — upsert on id; `status` is PRESERVED (operator owns it).
//   * connection   — upsert on id.
//   * credential   — deterministic id cred_excelnt_<sha256(key)[:16]>; a given
//                    key is written exactly once, a re-run adds only new keys.
//   * model        — keyed on the table-wide-unique slug; a slug owned by
//                    another provider is SKIPPED with a warning (never
//                    reassigned).
//   * provider_model — deterministic id pmdl_<model.id>.
//
// Usage:
//   set -a && . .env && set +a && node ops/onboard-excelnt.mjs [--dry-run]
//
// Knobs: EXCELNT_KEY_FILE, EXCELNT_PROVIDER_STATUS, EXCELNT_PRIORITY,
//        EXCELNT_PROBE_CONCURRENCY.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');

const KEY_FILE = process.env.EXCELNT_KEY_FILE ?? '/home/dwizzy/farm_x/excelnt/hasil_apikey.txt';
const PROVIDER_ID = 'prv_excelnt';
const PROVIDER_NAME = 'Excelnt';
const PROVIDER_SLUG = 'excelnt';
const CONNECTION_ID = 'con_prv_excelnt-default';
const BASE_URL = 'https://excelnt.ai/v1';
const PRIORITY = Number(process.env.EXCELNT_PRIORITY ?? 172);
const PROBE_CONC = Number(process.env.EXCELNT_PROBE_CONCURRENCY ?? 16);

// The upstream gates key-minting and API calls on this header; without it the
// chat path is refused while /models still answers.
const DEFAULT_HEADERS = { 'x-excelnt-client': 'vscode' };

// `provider.status` belongs to the operator: seed a new row 'active', but on
// re-run preserve whatever was stored. An explicit *PROVIDER_STATUS override
// (env var) wins.
const STATUS_ENV = (process.env.EXCELNT_PROVIDER_STATUS ?? '').trim();
const VALID_STATUS = ['active', 'dev', 'operational', 'degraded', 'disabled', 'maintenance', 'outage'];
if (STATUS_ENV && !VALID_STATUS.includes(STATUS_ENV)) {
  throw new Error(`EXCELNT_PROVIDER_STATUS=${STATUS_ENV} is not a valid provider.status`);
}

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

// ---------------------------------------------------------------------------
// keys — line format: [ts] email | pass: pw | key: sk_live_XXX
// ---------------------------------------------------------------------------
function loadKeys() {
  const seen = new Set();
  const out = [];
  let text = '';
  try {
    text = readFileSync(KEY_FILE, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /key:\s*(\S+)/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    if (!key.startsWith('sk_live_')) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const em = /(\S+@\S+)/.exec(line);
    out.push({ key, email: em ? em[1] : '' });
  }
  return out;
}

const credId = (key) => 'cred_excelnt_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
const idOf = (k) => credId(k.key);

// Bounded-concurrency map (no dependency; results in input order).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Verify a key against the upstream. Returns true only on an authenticated 200.
async function probeKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...DEFAULT_HEADERS },
      signal: AbortSignal.timeout(25_000)
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function fetchUpstreamModels(key) {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}`, ...DEFAULT_HEADERS },
    signal: AbortSignal.timeout(40_000)
  });
  if (!res.ok) throw new Error(`upstream /models -> HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((m) => ({
      slug: String(m?.id ?? '').trim(),
      name: String(m?.display_name ?? m?.name ?? m?.label ?? m?.id ?? '').trim(),
      context: Number(m?.context_window ?? 0) || null,
      maxOut: Number(m?.max_output_tokens ?? 0) || null,
      priceIn: Number(m?.pricing?.input ?? 0) || 0,
      priceOut: Number(m?.pricing?.output ?? 0) || 0,
      owner: String(m?.owned_by ?? '').trim()
    }))
    .filter((m) => m.slug !== '');
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });

  try {
    const all = loadKeys();
    if (all.length === 0) throw new Error(`no keys parsed from ${KEY_FILE}`);
    console.log(`keys parsed: ${all.length}`);

    // Verify every key; only live ones are imported.
    const live = await mapLimit(all, PROBE_CONC, async (k) => ((await probeKey(k.key)) ? k : null));
    const liveKeys = live.filter(Boolean);
    const deadKeys = all.filter((k) => !liveKeys.includes(k));
    console.log(`keys live: ${liveKeys.length}  dead: ${deadKeys.length}`);
    if (liveKeys.length === 0) throw new Error('no live keys — upstream rejected every key');

    const models = await fetchUpstreamModels(liveKeys[0].key);
    console.log(`upstream models advertised: ${models.length}`);

    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    // --- 1. provider -------------------------------------------------------
    const legacyBlob = encryptJson({
      api_key: liveKeys[0].key,
      auth_kind: 'apikey',
      default_headers: DEFAULT_HEADERS,
      accounts: liveKeys.map((k) => ({
        email: k.email || 'excelnt-key',
        access_token: k.key,
        refresh_token: null,
        expired: '2099-01-01T00:00:00Z'
      }))
    });

    await sql.begin(async (tx) => {
      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, priority, slug, tier, enabled)
        values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${legacyBlob},
                ${STATUS_ENV || 'active'}, ${PRIORITY}, ${PROVIDER_SLUG}, 'commercial', true)
        on conflict (id) do update set
          name = excluded.name,
          base_url = excluded.base_url,
          credentials_enc = excluded.credentials_enc,
          priority = excluded.priority,
          slug = excluded.slug,
          tier = excluded.tier,
          enabled = excluded.enabled,
          updated_at = now()${STATUS_ENV ? tx`, status = ${STATUS_ENV}` : tx``}`;

      // --- 2. connection ---------------------------------------------------
      const config = { auth_kind: 'apikey', default_headers: DEFAULT_HEADERS };
      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, enabled, priority, config)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, ${PROVIDER_NAME}, 'default', ${BASE_URL},
                'bearer', true, 100, ${tx.json(config)})
        on conflict (id) do update set
          base_url = excluded.base_url,
          config = excluded.config,
          enabled = excluded.enabled,
          updated_at = now()`;

      // --- 3. credentials (live keys only) ---------------------------------
      let newCreds = 0;
      for (const k of liveKeys) {
        const id = credId(k.key);
        const secret = encryptJson({ api_key: k.key, email: k.email });
        const meta = k.email ? { email: k.email } : {};
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${id}, ${CONNECTION_ID}, ${k.email || id}, ${secret}, 'unknown', ${tx.json(meta)})
          on conflict (id) do nothing
          returning id`;
        if (r.length > 0) newCreds += 1;
      }
      // A key that the farm has revoked must stop being tried.
      let invalidated = 0;
      for (const k of deadKeys) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${idOf(k)} and status <> 'invalid'
          returning id`;
        if (r.length > 0) invalidated += 1;
      }
      console.log(`credentials: ${newCreds} new, ${liveKeys.length - newCreds} already present, ${invalidated} marked invalid`);

      // --- 4 + 5. models + provider_model ---------------------------------
      let newModels = 0;
      let mapped = 0;
      let skipped = 0;
      for (const m of models) {
        const ins = await tx`
          insert into model (id, provider_id, name, slug, context, input_price, output_price,
                             status, developer, max_output)
          values (${randomUUID()}, ${PROVIDER_ID}, ${m.name || m.slug}, ${m.slug}, ${m.context},
                  ${m.priceIn}, ${m.priceOut}, 'active', ${m.owner || null}, ${m.maxOut})
          on conflict (slug) do nothing
          returning id`;
        let modelId;
        if (ins.length > 0) {
          modelId = ins[0].id;
          newModels += 1;
        } else {
          const [row] = await tx`select id, provider_id from model where slug = ${m.slug} limit 1`;
          if (!row || row.provider_id !== PROVIDER_ID) {
            console.log(`  skip slug ${m.slug} (owned by ${row?.provider_id ?? '?'})`);
            skipped += 1;
            continue;
          }
          modelId = row.id;
        }
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pmdl_' + modelId}, ${modelId}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.slug}, true, 'available')
          on conflict (id) do update set
            provider_model_id = excluded.provider_model_id,
            enabled = true,
            status = 'available',
            updated_at = now()`;
        mapped += 1;
      }
      console.log(`models: ${newModels} new, ${mapped} mapped to ${PROVIDER_ID}, ${skipped} skipped (slug owned elsewhere)`);
    });

    // --- report ------------------------------------------------------------
    const [p] = await sql`select id, name, status, priority from provider where id = ${PROVIDER_ID}`;
    const [cc] = await sql`
      select count(*)::int n, count(*) filter (where status = 'invalid')::int inv
      from credential where connection_id = ${CONNECTION_ID}`;
    const [mm] = await sql`select count(*)::int n from provider_model where provider_id = ${PROVIDER_ID}`;
    console.log(`provider ${p.id} (${p.name}) status=${p.status} priority=${p.priority}`);
    console.log(`connection ${CONNECTION_ID} credentials=${cc.n} (invalid=${cc.inv}) provider_models=${mm.n}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
