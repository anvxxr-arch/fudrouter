#!/usr/bin/env node
// ops/onboard-freemodel.mjs — onboard freemodel.in (OpenAI-compatible; 1,000,000
// free tokens/month per account, the "bansos" pool) into fudrouter.
//
// Why a script and not SQL: provider/credential secrets are AES-256-GCM
// ciphertext (`provider.credentials_enc`, `credential.secret_enc`) whose
// envelope only code holding CREDENTIALS_MASTER_KEY can produce — the same
// base64(iv[12] || ct || tag[16]) format as backend/go/internal/crypt.
//
// Idempotent by construction:
//   * provider     — upsert on id; `status` is PRESERVED unless FM_PROVIDER_STATUS
//                    is set explicitly (the operator owns it).
//   * connection   — upsert on id.
//   * credential   — deterministic id cred_freemodel_<sha256(key)[:16]>.
//   * model        — REUSED when the slug already exists in the catalogue (the
//                    canonical row wins: owner and prices are never rewritten).
//                    A genuinely new slug is inserted free (price 0) from the
//                    upstream metadata.
//   * provider_model — id pmdl_fm_<model.id>; the bare pmdl_<mid> form used by
//                    other onboarders COLLIDES across providers, so it is not.
//
// QUOTA PROBE, NOT A CHAT PROBE. freemodel.in fronts an nginx rate gate that
// answers 502 to a burst of chat calls, so a chat probe manufactured dead keys
// (measured: 88x502 + 66 timeouts at concurrency 24 — all keys were alive). The
// authoritative signal is the rate-limit headers on a lightweight GET /models:
//   X-RateLimit-Limit-Tokens / X-RateLimit-Remaining-Tokens
// remaining > 0 -> 'healthy' (routable now); remaining = 0 -> 'cooldown' (the
// month is spent; the row is kept so the reset re-arms it). Only 401/403 is a
// dead key. A key whose /models never answers is imported 'healthy' with a note:
// it authenticated, and the router treats an upstream 5xx as retryable and walks
// to the next credential.
//
// ORPHAN REVIVAL: flagship slugs already in the catalogue carry status='inactive'
// because their ONLY provider (prv_inferhub / prv_unikey / prv_excelnt) is
// disabled — the roster kept the name and dropped the stock. Attaching a live
// provider_model does not make such a row servable on its own (ActiveModels and
// Candidates both require m.status='active'), so those rows are flipped back to
// 'active'. Prices are left exactly as they were: repricing a catalogue row is an
// operator decision, not an onboarding side effect — the run prints every
// non-zero price it adopted so that decision can be made deliberately.
//
// Usage:
//   set -a && . .env && set +a && node ops/onboard-freemodel.mjs [--dry-run]
//
// Knobs: FM_KEY_FILE, FM_PROVIDER_STATUS, FM_PRIORITY, FM_PROBE_CONCURRENCY,
//        FM_NO_REVIVE.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');

const KEY_FILE = process.env.FM_KEY_FILE ?? '/home/dwizzy/.hermes/cache/scratch/fm_import_keys.txt';
const PROVIDER_ID = 'prv_freemodel';
const PROVIDER_NAME = 'FreeModel';
const PROVIDER_SLUG = 'freemodel';
const CONNECTION_ID = 'con_prv_freemodel-default';
const BASE_URL = 'https://freemodel.in/v1';
// Lower = tried first (routing/select orders provider.priority ASC). 183 free
// accounts x 1M tokens/month should be spent before the metered pools
// (tokenharbor 160, zro 161, dahl 163, tokenjuice 165).
const PRIORITY = Number(process.env.FM_PRIORITY ?? 155);
const PROBE_CONC = Number(process.env.FM_PROBE_CONCURRENCY ?? 8);
const PROBE_ROUNDS = Number(process.env.FM_PROBE_ROUNDS ?? 2);
const NO_REVIVE = process.env.FM_NO_REVIVE === '1';
// Sharding: `connections` (default 3) connection rows so no single row carries
// the whole 10k pool. `CandidatesBatch` returns every usable credential of a
// connection in one json_agg on EVERY request (measured: ~4.1 MB of JSON at
// 10k rows of realistic shape, 53 ms DB-side), so a monolithic pool is a
// throughput ceiling. A connection per shard keeps each json_agg small and the
// pool reload cheap.
//
// SPLIT_AT defaults to 0 / SHARDS to 3, i.e. shard ALWAYS. The old default
// (split only past 1e6 keys) was dead code: the sync loop hands the onboarder
// just the delta (a few dozen keys), so a batch-size test can never fire and
// fresh keys silently pile back into shard 0. Placement is deterministic
// (see shardOf), so unconditional sharding is idempotent.
const SPLIT_AT = Number(process.env.FM_SPLIT_AT ?? 0);
const SHARDS = Math.max(1, Number(process.env.FM_SHARDS ?? 3));

const STATUS_ENV = (process.env.FM_PROVIDER_STATUS ?? '').trim();
const VALID_STATUS = ['active', 'dev', 'operational', 'degraded', 'disabled', 'maintenance', 'outage'];
if (STATUS_ENV && !VALID_STATUS.includes(STATUS_ENV)) {
  throw new Error(`FM_PROVIDER_STATUS=${STATUS_ENV} is not a valid provider.status`);
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
// keys — one bare `fm_<48 hex>` per line; dedup on the key itself.
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
    const m = /(fm_[a-f0-9]{48})/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ key: m[1] });
  }
  return out;
}

const credId = (key) => 'cred_freemodel_' + createHash('sha256').update(key).digest('hex').slice(0, 16);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const V_OK = 'healthy';
const V_COOLDOWN = 'cooldown';
const V_DEAD = 'invalid';
const V_UNKNOWN = 'unknown';

// Read the monthly token allowance off GET /models. Returns {status, remaining, limit, note}.
async function probeQuota(key) {
  let note = '';
  for (let attempt = 0; attempt < PROBE_ROUNDS; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(40_000)
      });
      if (res.status === 401 || res.status === 403) {
        // Drain the body so the socket is reusable; the verdict is the status.
        await res.text();
        return { status: V_DEAD, remaining: null, limit: null, note: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        note = `HTTP ${res.status}`;
        await res.text();
      } else {
        const limit = Number(res.headers.get('x-ratelimit-limit-tokens') ?? NaN);
        const remaining = Number(res.headers.get('x-ratelimit-remaining-tokens') ?? NaN);
        const body = await res.text();
        if (!Number.isFinite(remaining)) {
          // No header: fall back to "does it look like a model list".
          note = body.includes('"data"') ? 'no quota header' : 'unexpected body';
        } else if (remaining > 0) {
          return { status: V_OK, remaining, limit, note: '' };
        } else {
          return { status: V_COOLDOWN, remaining, limit, note: 'monthly quota spent' };
        }
      }
    } catch (e) {
      note = e.name || 'error';
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  // Authenticated but unmeasurable (gate-throttled, not rejected).
  return { status: V_UNKNOWN, remaining: null, limit: null, note };
}

async function fetchUpstreamModels(key) {
  // GET /models is NOT a health signal on this target: the nginx edge answers
  // 502 to bursts while chat/completions serves fine, and a single 502 here
  // used to abort the whole import (measured: 34/34 keys passed the quota
  // probe, then "upstream /models -> HTTP 502", rc=1, zero rows written).
  // Retry the edge before treating the catalogue as unavailable.
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(40_000)
      });
      if (!res.ok) throw new Error(`upstream /models -> HTTP ${res.status}`);
      const body = JSON.parse(await res.text());
      const rows = Array.isArray(body?.data) ? body.data : [];
      return rows
        .map((m) => ({
          slug: String(m?.id ?? '').trim(),
          name: String(m?.name ?? m?.display_name ?? m?.id ?? '').trim(),
          context: Number(m?.context_window ?? 0) || null,
          description: String(m?.description ?? '').trim(),
          caps: Array.isArray(m?.capabilities) ? m.capabilities.map(String) : [],
          inputs: Array.isArray(m?.input_modalities) && m.input_modalities.length
            ? m.input_modalities.map(String)
            : ['text']
        }))
        .filter((m) => m.slug !== '');
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Fallback catalogue: the models this provider is ALREADY mapped to. The
// catalog import reuses existing model rows anyway, so a transient /models
// outage must not block new credentials from joining a live pool.
async function fetchMappedModels(sql) {
  const rows = await sql`
    select distinct pm.provider_model_id as slug
    from provider_model pm
    join model m on m.id = pm.model_id
    where pm.provider_id = ${PROVIDER_ID} and m.status = 'active'`;
  return rows
    .map((r) => ({
      slug: String(r.slug ?? '').trim(),
      name: String(r.slug ?? '').trim(),
      context: null,
      description: '',
      caps: [],
      inputs: ['text']
    }))
    .filter((m) => m.slug !== '');
}

function familyOf(slug) {
  const s = slug.toLowerCase();
  for (const f of ['claude', 'gpt', 'gemini', 'gemma', 'deepseek', 'grok', 'kimi', 'qwen', 'glm', 'mimo', 'seed', 'muse', 'matilda', 'codex']) {
    if (s.includes(f)) return f;
  }
  return null;
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });

  try {
    const all = loadKeys();
    if (all.length === 0) throw new Error(`no keys parsed from ${KEY_FILE}`);
    console.log(`keys parsed: ${all.length}`);

    const results = await mapLimit(all, PROBE_CONC, async (k, i) => {
      const r = await probeQuota(k.key);
      if ((i + 1) % 25 === 0) console.log(`  probed ${i + 1}/${all.length}`);
      return { ...k, ...r };
    });
    const healthy = results.filter((r) => r.status === V_OK);
    const cooldown = results.filter((r) => r.status === V_COOLDOWN);
    const dead = results.filter((r) => r.status === V_DEAD);
    const unknown = results.filter((r) => r.status === V_UNKNOWN);
    const budget = healthy.reduce((a, r) => a + (r.remaining ?? 0), 0);
    console.log(`quota probe: healthy=${healthy.length} cooldown=${cooldown.length} dead=${dead.length} unknown=${unknown.length}`);
    console.log(`routable budget: ${budget.toLocaleString('en-US')} tokens (1M/month per account)`);
    if (unknown.length) {
      console.log('untested (gate-throttled, imported healthy):');
      for (const u of unknown.slice(0, 20)) console.log(`  ${u.key.slice(0, 12)}…  ${u.note}`);
    }
    if (healthy.length === 0) throw new Error('no key with a live monthly quota — refusing to onboard an empty pool');

    // Import healthy + unknown (both authenticated); cooldown keys are parked.
    const live = [...healthy, ...unknown];

    let models;
    try {
      models = await fetchUpstreamModels(live[0].key);
      console.log(`upstream models advertised: ${models.length}`);
    } catch (e) {
      console.log(`upstream /models unavailable (${e.message}) — falling back to the models already mapped to ${PROVIDER_ID}`);
      models = await fetchMappedModels(sql);
      console.log(`mapped models reused: ${models.length}`);
    }

    if (DRY) {
      console.log(`--dry-run: no writes. would import ${live.length} routable + ${cooldown.length} parked + ${dead.length} invalid`);
      for (const m of models) console.log(`  ${m.slug}  ctx=${m.context ?? '-'}  caps=[${m.caps.join(',')}]`);
      return;
    }

    const legacyBlob = encryptJson({
      api_key: live[0].key,
      auth_kind: 'apikey',
      default_headers: {},
      accounts: live.map((k, i) => ({
        email: `freemodel-key-${i + 1}@freemodel.in`,
        api_key: k.key,
        access_token: k.key,
        refresh_token: null,
        expired: '2099-01-01T00:00:00Z'
      }))
    });

    const adopted = [];
    // Declared outside the transaction: the report below counts credentials
    // across every shard, and a const inside the tx callback is out of scope.
    const connRows = [];
    // Shard count is decided by the TOTAL pool, not by this import's batch:
    // the sync loop feeds the onboarder only the delta (a few dozen keys), so a
    // batch-size check would never trigger the split and all 10k credentials
    // would pile into one connection row.
    const shardPrefix = `${CONNECTION_ID}-s`;
    const [existing] = await sql`
      select count(*)::int n from credential
      where connection_id = ${CONNECTION_ID} or connection_id like ${shardPrefix + '%'}`;
    const poolSize = existing.n + live.length;
    const shardCount = poolSize >= SPLIT_AT ? SHARDS : 1;
    // Deterministic placement: `credId` is `cred_freemodel_` + the first 16 hex
    // of sha256(key), so hashing the ID's first byte and hashing the key's first
    // byte are the same decision — and deriving it from the ID means a rebalance
    // can be pure SQL (no decrypt, no network).
    const shardOf = (id) => parseInt(id.slice(15, 17), 16) % shardCount;
    await sql.begin(async (tx) => {
      // --- 1. provider -----------------------------------------------------
      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, priority, slug, type, tier, enabled, homepage)
        values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${legacyBlob}, ${STATUS_ENV || 'active'},
                ${PRIORITY}, ${PROVIDER_SLUG}, 'openai_compatible', 'commercial', true, 'https://freemodel.in')
        on conflict (id) do update set
          name = excluded.name,
          base_url = excluded.base_url,
          credentials_enc = excluded.credentials_enc,
          priority = excluded.priority,
          slug = excluded.slug,
          type = excluded.type,
          enabled = true,
          updated_at = now()${STATUS_ENV ? tx`, status = ${STATUS_ENV}` : tx``}`;

      // --- 2. connection ---------------------------------------------------
      // One row per shard when the pool is large enough to need splitting.
      const connCount = shardCount;
      for (let s = 0; s < connCount; s += 1) {
        const cid = s === 0 ? CONNECTION_ID : `${CONNECTION_ID}-s${s + 1}`;
        connRows.push(cid);
        await tx`
          insert into connection (id, provider_id, name, slug, base_url, auth_type, enabled, priority, config)
          values (${cid}, ${PROVIDER_ID}, ${s === 0 ? PROVIDER_NAME : `${PROVIDER_NAME} shard ${s + 1}`}, ${s === 0 ? 'default' : `shard-${s + 1}`}, ${BASE_URL},
                  'bearer', true, ${PRIORITY},
                  ${tx.json({ auth_kind: 'apikey', default_headers: {}, budget_metered: true })})
          on conflict (id) do update set
            base_url = excluded.base_url, config = excluded.config, enabled = true, updated_at = now()`;
      }
      console.log(`connections: ${connRows.length} (${connRows.join(', ')})`);

      // --- 3. credentials --------------------------------------------------
      let newCreds = 0;
      let refreshed = 0;
      const connFor = (id) => connRows[shardOf(id)];
      for (const k of live) {
        const id = credId(k.key);
        // 'healthy' is load-bearing: poolrebuild carries ONLY status='healthy'
        // rows into provider.credentials_enc, so a row left 'unknown' silently
        // vanishes from routing.
        const meta = { source: 'freemodel.in', quota_check: k.status, shard: connFor(id) };
        if (k.remaining != null) meta.remaining_tokens = k.remaining;
        if (k.note) meta.note = k.note;
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${id}, ${connFor(id)}, ${id}, ${encryptJson({ api_key: k.key })}, 'healthy', ${tx.json(meta)})
          on conflict (id) do update set
            connection_id = excluded.connection_id,
            secret_enc = excluded.secret_enc, status = 'healthy',
            cooldown_until = null, metadata = excluded.metadata, updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
        else refreshed += 1;
      }
      console.log(`credentials: ${newCreds} new, ${refreshed} refreshed across ${connRows.length} connection(s)`);

      // A spent month is temporary: park the row instead of discarding the key.
      if (cooldown.length) {
        for (const k of cooldown) {
          const id = credId(k.key);
          await tx`
            insert into credential (id, connection_id, name, secret_enc, status, cooldown_until, metadata)
            values (${id}, ${connFor(id)}, ${id}, ${encryptJson({ api_key: k.key })}, 'cooldown',
                    now() + interval '30 days',
                    ${tx.json({ source: 'freemodel.in', quota_check: 'cooldown', note: k.note, shard: connFor(id) })})
            on conflict (id) do update set
              secret_enc = excluded.secret_enc, status = 'cooldown',
              cooldown_until = now() + interval '30 days',
              metadata = excluded.metadata, updated_at = now()`;
        }
        console.log(`parked in cooldown: ${cooldown.length} accounts with a spent monthly quota`);
      }

      let invalidated = 0;
      for (const k of dead) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${credId(k.key)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      if (invalidated) console.log(`marked invalid: ${invalidated}`);

      // --- 4 + 5. models + provider_model ---------------------------------
      let newModels = 0;
      let reused = 0;
      let revived = 0;
      let mapped = 0;
      for (const m of models) {
        const ins = await tx`
          insert into model (id, provider_id, name, slug, context, max_output, input_price, output_price,
                             family, developer, description, modality, capabilities, status)
          values (${randomUUID()}, ${PROVIDER_ID}, ${m.name || m.slug}, ${m.slug}, ${m.context}, null,
                  0, 0, ${familyOf(m.slug)}, 'freemodel', ${m.description || null},
                  ${tx.json({ input: m.inputs, output: ['text'] })},
                  ${tx.json({ chat: true, ...(m.caps.length ? { features: m.caps } : {}) })}, 'active')
          on conflict (slug) do nothing
          returning id`;
        let modelId;
        if (ins.length > 0) {
          modelId = ins[0].id;
          newModels += 1;
        } else {
          // Canonical row wins: owner and prices stay exactly as they are.
          const [row] = await tx`select id, status, input_price, output_price from model where slug = ${m.slug} limit 1`;
          if (!row) {
            console.log(`  skip ${m.slug} (no row after conflict)`);
            continue;
          }
          modelId = row.id;
          reused += 1;
          if (Number(row.input_price) > 0 || Number(row.output_price) > 0) {
            adopted.push(`${m.slug} = $${(Number(row.input_price) / 1e6).toFixed(2)}/1M in, $${(Number(row.output_price) / 1e6).toFixed(2)}/1M out`);
          }
          if (row.status !== 'active' && !NO_REVIVE) {
            await tx`update model set status = 'active', updated_at = now() where id = ${modelId}`;
            revived += 1;
          } else if (row.status !== 'active') {
            console.log(`  ${m.slug} is ${row.status} — attached but NOT servable (FM_NO_REVIVE=1)`);
          }
        }

        // Fan the model out across EVERY shard: the candidate query joins
        // provider_model → connection, so a model mapped to one connection can
        // only reach that connection's credentials. Mapping it per shard is what
        // makes the whole split pool reachable.
        for (let s = 0; s < connRows.length; s += 1) {
          const pmID = s === 0 ? `pmdl_fm_${modelId}` : `pmdl_fm_${modelId}_s${s + 1}`;
          await tx`
            insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
            values (${pmID}, ${modelId}, ${PROVIDER_ID}, ${connRows[s]}, ${m.slug}, true, 'available')
            on conflict (id) do update set
              provider_model_id = excluded.provider_model_id,
              connection_id = excluded.connection_id,
              enabled = true,
              status = 'available',
              updated_at = now()`;
        }
        mapped += 1;
      }
      console.log(`models: ${newModels} new, ${reused} reused${revived ? `, ${revived} revived from inactive` : ''}, ${mapped} mapped`);
    });

    if (adopted.length) {
      console.log(`\nADOPTED CATALOGUE PRICES (not free — operator may want to zero these):`);
      for (const a of adopted) console.log(`  ${a}`);
    }

    // --- report ------------------------------------------------------------
    const [p] = await sql`select id, name, status, priority from provider where id = ${PROVIDER_ID}`;
    const [cc] = await sql`
      select count(*)::int n,
             count(*) filter (where status = 'healthy')::int healthy,
             count(*) filter (where status = 'cooldown')::int cooldown,
             count(*) filter (where status = 'invalid')::int inv
      from credential where connection_id = any (${sql.array(connRows)})`;
    const [mm] = await sql`select count(*)::int n from provider_model where provider_id = ${PROVIDER_ID}`;
    const [cat] = await sql`
      select count(*)::int n from model m
      join provider_model pm on pm.model_id = m.id
      join provider p on p.id = pm.provider_id
      where pm.provider_id = ${PROVIDER_ID} and m.status = 'active' and pm.enabled
        and p.enabled and p.tier = 'commercial' and p.status not in ('disabled','maintenance','outage')`;
    console.log(`\nprovider ${p.id} (${p.name}) status=${p.status} priority=${p.priority}`);
    console.log(`connection ${CONNECTION_ID} credentials=${cc.n} (healthy=${cc.healthy} cooldown=${cc.cooldown} invalid=${cc.inv})`);
    console.log(`provider_models=${mm.n}  servable in catalogue=${cat.n}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
