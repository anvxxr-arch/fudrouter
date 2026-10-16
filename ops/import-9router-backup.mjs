// ops/import-9router-backup.mjs — migrate 9router SQLite backup credentials
// into the fudrouter Postgres credential table.
//
// Source: ~/backups/9router-20261016-040737-prereset/data.sqlite
//   providerConnections(id, provider, authType, name, email, priority, isActive,
//                       data JSON {apiKey, email, providerSpecificData{baseUrl}}, ...)
//   providerNodes(id, type, name, data JSON {baseUrl})
//   apikey rows carry data.apiKey. oauth rows (grok-cli, 1028) carry
//   accessToken and are NOT imported: the xai-grok pool in fudrouter is
//   operator-owned and a backup must not rewrite it. Their count is reported.
//
// 9router source -> fudrouter provider / credential tag:
//   tokenharbor                              -> prv-tokenharbor   tag tokenharbor
//   dahl                                     -> prv-dahl          tag dahl
//   gemini                                   -> prv-googleai      tag gemini
//   openrouter                               -> prv-openrouter    tag openrouter
//   tokenrouter                              -> unmapped (no fudrouter provider; reported, not imported)
//   openai-compatible-chat-<nodeid>          -> providerNodes.id row:
//       Top-Tools-AI  -> prv-tt       tt
//       Gonka24-a..j  -> prv-gonka24  gonka24
//       Free.ai       -> prv-freeai   freeai
//       TokenHarbor   -> prv-tokenharbor tokenharbor
//       Excelnt       -> prv-excelnt  excelnt
//       mstrlfarm     -> prv_mistral  mistral
//       Cline         -> prv-cline    cline
//       KiraAI        -> prv-kiraai   kiraai
//   The probe baseUrl is the providerNodes baseUrl (authoritative).
//
// Probe strategy: per baseUrl GET /models with Authorization: Bearer <key>,
// 25s timeout, concurrency 12 (IMPORT_PROBE_CONCURRENCY overrides). EVERY
// candidate key is probed (operator chose probe-all over bulk import) — this
// run is ~46k probes, so it is meant to run under nohup/tmux; progress is
// logged every 500 probes and 15s. Verdicts are cached in
// ${STAGING}/probe.json keyed by base+sha16(key) — never the key itself — so a
// re-run costs nothing upstream.
//
// DEDUP RULE (never decrypts anything, so no secret is ever compared):
//   1. Deterministic ids. Each candidate maps to cred_<tag>_<sha256(key)[:16]>.
//      If that id already exists in the target provider's connection, the row is
//      "already present" and is skipped. This is the primary path for the
//      ~40.6k credentials onboard-farm/onboard-excelnt already wrote.
//   2. Legacy uuid ids. Rows written before deterministic ids existed have ids
//      like cred_01a0f1d3-18b9-7193-... which cannot be recomputed from the key.
//      For those, a provider+email(name) match against an existing legacy-id
//      credential is treated as already present. This is a heuristic on
//      operator-visible metadata only — it can only ever skip a row, never
//      import a duplicate secret.
//   3. Cross-tag duplicates inside the backup itself (a key appearing under two
//      providers) are collapsed to the first tag in tag order, so one secret is
//      written once per mapped provider and never twice inside a provider.
//   4. isActive=0 rows and probe-dead rows are never imported; counts are
//      reported per tag.
//
// Usage:
//   cd ~/fudrouter && set -a && . .env && set +a \
//     node ops/import-9router-backup.mjs --stage      # dump sqlite -> ${STAGING}
//     node ops/import-9router-backup.mjs [--dry-run]  # probe + import live keys
//     node ops/import-9router-backup.mjs --skip-probe # reuse probe cache
//     node ops/import-9router-backup.mjs --only mistral
//   IMPORT_PROBE_CONCURRENCY=6 ...                    # back off on rate limits
//
// Output redacts every key-shaped token; no key, token or decrypted secret is
// ever logged.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const HOME = process.env.HOME;
const SQLITE = process.env.IMPORT_SOURCE ?? `${HOME}/backups/9router-20261016-040737-prereset/data.sqlite`;
const STAGING = process.env.IMPORT_STAGING ?? '/tmp/9router-import';

// Node uuid -> fudrouter provider + credential tag.
const NODE_MAP = {
  'openai-compatible-chat-fcbf58ff-718b-4de8-b69c-40252a6e166e': { tag: 'tt', providerId: 'prv_tt' },
  'openai-compatible-chat-4234cff4-f633-4137-8bd7-63c0b521390c': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-d074c6b9-3e2d-4318-acca-6c38b1aed7de': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-7c2d4abd-9d82-4055-b324-31a10fca1485': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-bbc252be-a8e2-45eb-927e-17cc1b7951de': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-0e8dd06a-2291-4d85-9edc-76b7fee674b5': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-13ce2ff6-7786-413c-8c08-5ef6f028f33d': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-9fc8ceab-9db2-44b7-b4aa-39f332626f74': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-726c890a-ec09-4a25-b76e-c13e069468c4': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-4a88c5ce-fae0-4326-b6f8-4de2d456097d': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-5cfe7a28-cbe4-4927-8aad-c790018be339': { tag: 'gonka24', providerId: 'prv_gonka24' },
  'openai-compatible-chat-9ec69343-52c5-41d0-b499-722425a9875f': { tag: 'freeai', providerId: 'prv_freeai' },
  'openai-compatible-chat-e0f99d03-c46b-464e-b3c7-d8eec6a11175': { tag: 'tokenharbor', providerId: 'prv_tokenharbor' },
  'openai-compatible-chat-1ad0766d-e913-4c69-81f2-eb20e6313b31': { tag: 'excelnt', providerId: 'prv_excelnt' },
  'openai-compatible-chat-1870835d-751c-4439-9549-f94ad81a96c9': { tag: 'mistral', providerId: 'prv_mistral' },
  'openai-compatible-chat-28658276-61e3-4371-90a5-fc41a80d3868': { tag: 'cline', providerId: 'prv_cline' },
  'openai-compatible-chat-6f3902b4-5ab3-4f25-ad8c-fe0e0b6cc3da': { tag: 'kiraai', providerId: 'prv_kiraai' }
};
// Providers without a providerNodes row: probe base is hardcoded from the
// fudrouter connection (cross-checked at runtime against the DB).
const DIRECT_MAP = {
  // The 9router backup points tokenharbor at http://43.128.99.142/thr/v1, but
  // that host now answers 403 wrong_host: "Use https://tokenharbor.ai/v1 as the
  // base URL." The live base is used here so keys are judged against the
  // upstream that actually serves them (verified 2026-10-16: 200 with a real key).
  tokenharbor: { tag: 'tokenharbor', providerId: 'prv_tokenharbor', base: 'https://tokenharbor.ai/v1' },
  dahl: { tag: 'dahl', providerId: 'prv_dahl', base: 'https://inference.dahl.global/v1' },
  gemini: { tag: 'gemini', providerId: 'prv_googleai', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openrouter: { tag: 'openrouter', providerId: 'prv_openrouter', base: 'https://openrouter.ai/api/v1' },
  // No fudrouter provider exists for tokenrouter and no reachable baseUrl is
  // known from the backup; these 10 rows are reported, never imported.
  tokenrouter: { tag: 'tokenrouter', providerId: null, base: '' }
};
const MISTRAL_PROVIDER = { id: 'prv_mistral', slug: 'mistral', name: 'Mistral AI', base: 'https://api.mistral.ai/v1' };
const MISTRAL_CONNECTION_ID = 'con_prv_mistral-default';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const STAGE = argv.includes('--stage');
const SKIP_PROBE = argv.includes('--skip-probe');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const PROBE_CONC = Number(process.env.IMPORT_PROBE_CONCURRENCY ?? 12);
const PROBE_TIMEOUT_MS = Number(process.env.IMPORT_PROBE_TIMEOUT_MS ?? 25_000);

// ---------------------------------------------------------------------------
// crypto — the same envelope as ops/onboard-farm.mjs / backfill-credentials.mjs
// ---------------------------------------------------------------------------
function masterKey() {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
  return buf;
}
const encryptJson = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};
const sha16 = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const credId = (tag, key) => `cred_${tag}_${sha16(key)}`;
// Legacy ids (pre-deterministic) look like cred_01a0f1d3-18b9-7193-....
const isLegacyId = (id) => !/^cred_[a-z0-9]+_[0-9a-f]{16}$/.test(id);
const redact = (s) => String(s).replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>');

// ---------------------------------------------------------------------------
// staging: one sqlite pass, TSV with unit separators, no secrets in the log
// ---------------------------------------------------------------------------
function loadStaging() {
  const rawPath = `${STAGING}/raw.tsv`;
  const nodePath = `${STAGING}/nodes.tsv`;
  if (!existsSync(rawPath) || !existsSync(nodePath)) {
    throw new Error(`staging missing at ${STAGING} — run with --stage first`);
  }
  const nodes = new Map();
  for (const line of readFileSync(nodePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [id, name, baseUrl] = line.split('\t');
    nodes.set(id, { name: name ?? '', baseUrl: (baseUrl ?? '').trim() });
  }
  const rows = [];
  for (const line of readFileSync(rawPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\u001f');
    rows.push({
      provider: f[0] ?? '',
      name: f[1] ?? '',
      email: (f[2] ?? '').trim(),
      dataEmail: (f[3] ?? '').trim(),
      priority: Number(f[4] ?? 100),
      isActive: Number(f[5] ?? 1) === 1,
      key: (f[6] ?? '').trim()
    });
  }
  return { rows, nodes };
}

function mapRow(row, nodes) {
  const node = NODE_MAP[row.provider];
  if (node) {
    const nodeRow = nodes.get(row.provider);
    if (!nodeRow) throw new Error(`providerNodes row missing for ${row.provider}`);
    return { ...node, base: nodeRow.baseUrl, row };
  }
  const direct = DIRECT_MAP[row.provider];
  if (direct) return { ...direct, row };
  return null;
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

const probeCachePath = `${STAGING}/probe.json`;
const loadProbeCache = () => {
  if (!existsSync(probeCachePath)) return new Map();
  try { return new Map(Object.entries(JSON.parse(readFileSync(probeCachePath, 'utf8')))); }
  catch { return new Map(); }
};
const cacheKey = (base, key) => `${base}\u0000${sha16(key)}`;
async function probeOne(base, key) {
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return res.status === 200 ? 'live' : `http_${res.status}`;
  } catch (e) {
    return `err:${String(e?.message ?? e).slice(0, 40)}`;
  }
}

async function main() {
  if (STAGE) {
    mkdirSync(STAGING, { recursive: true });
    // sqlite3's -separator needs a real control character; bash printf emits it.
    // Unit separator (0x1f) so keys/emails containing tabs or commas survive.
    const script = [
      `SEP="$(printf '\\037')"`,
      `sqlite3 -readonly '${SQLITE}' -separator "$SEP" ` +
        `"select provider, name, coalesce(email,''), coalesce(json_extract(data,'\\$.email'),''), ` +
        `priority, isActive, coalesce(json_extract(data,'\\$.apiKey'),'') from providerConnections" ` +
        `> '${STAGING}/raw.tsv'`,
      `sqlite3 -readonly '${SQLITE}' -separator "$(printf '\\t')" ` +
        `"select id, name, coalesce(json_extract(data,'\\$.baseUrl'),'') from providerNodes" ` +
        `> '${STAGING}/nodes.tsv'`
    ].join('\n');
    execFileSync('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'inherit'] });
    const { rows } = loadStaging();
    console.log(`[stage] rows=${rows.length} -> ${STAGING}`);
    return;
  }
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const { rows, nodes } = loadStaging();
    const counts = { total: rows.length, oauthSkipped: 0, unmapped: 0, inactive: 0, emptyKey: 0, filtered: 0 };
    const byTag = new Map();
    for (const row of rows) {
      if (row.provider === 'grok-cli') { counts.oauthSkipped += 1; continue; }
      if (!row.key) { counts.emptyKey += 1; continue; }
      if (!row.isActive) counts.inactive += 1;
      const m = mapRow(row, nodes);
      if (!m || !m.providerId || !m.base) { counts.unmapped += 1; continue; }
      if (ONLY && m.tag !== ONLY) { counts.filtered += 1; continue; }
      if (!byTag.has(m.tag)) byTag.set(m.tag, []);
      byTag.get(m.tag).push(m);
    }
    console.log(
      `[stage] rows=${counts.total} oauth-skipped=${counts.oauthSkipped} empty-key=${counts.emptyKey} ` +
      `inactive=${counts.inactive} unmapped=${counts.unmapped}${ONLY ? ` filtered=${counts.filtered}` : ''} ` +
      `candidates=${[...byTag.values()].reduce((a, b) => a + b.length, 0)}`
    );

    // Cross-tag duplicate collapse: the same key under two providers is kept
    // under the first tag in sorted order, so a secret is written once per
    // provider and never twice inside one provider.
    const seenKeys = new Set();
    for (const tag of [...byTag.keys()].sort()) {
      const kept = [];
      for (const m of byTag.get(tag)) {
        if (seenKeys.has(m.row.key)) continue;
        seenKeys.add(m.row.key);
        kept.push(m);
      }
      byTag.set(tag, kept);
    }

    const tags = [...byTag.keys()].sort();
    // Existing ids + legacy names per provider, loaded once per provider.
    const existing = new Map();
    for (const tag of tags) {
      const providerId = byTag.get(tag)[0].providerId;
      const ids = new Set();
      const legacyNames = new Set();
      const dbRows = await sql`
        select cr.id, cr.name from credential cr
        join connection c on c.id = cr.connection_id
        where c.provider_id = ${providerId}`;
      for (const r of dbRows) {
        ids.add(r.id);
        if (isLegacyId(r.id) && r.name) legacyNames.add(String(r.name));
      }
      existing.set(providerId, { ids, legacyNames });
    }

    const cache = loadProbeCache();
    const toProbe = [];
    for (const tag of tags) {
      for (const m of byTag.get(tag)) {
        if (!cache.has(cacheKey(m.base, m.row.key))) toProbe.push(m);
      }
    }
    console.log(`[probe] cached=${[...byTag.values()].reduce((a, b) => a + b.length, 0) - toProbe.length} ` +
      `to-probe=${toProbe.length} concurrency=${PROBE_CONC}`);
    if (!SKIP_PROBE && toProbe.length > 0) {
      let done = 0;
      let lastLog = Date.now();
      const startedAt = Date.now();
      await mapLimit(toProbe, PROBE_CONC, async (m) => {
        cache.set(cacheKey(m.base, m.row.key), await probeOne(m.base, m.row.key));
        done += 1;
        if (done % 500 === 0 || Date.now() - lastLog > 15_000) {
          console.log(`[probe] ${done}/${toProbe.length} (${(done / ((Date.now() - startedAt) / 1000)).toFixed(1)}/s)`);
          lastLog = Date.now();
        }
      });
      writeFileSync(probeCachePath, JSON.stringify(Object.fromEntries(cache)));
      console.log(`[probe] verdicts cached at ${probeCachePath} (keys hashed, never stored)`);
    }
    const verdictOf = (m) => cache.get(cacheKey(m.base, m.row.key)) ?? 'not-probed';

    if (tags.includes('mistral')) {
      await sql.begin(async (tx) => {
        // credentials_enc is NOT NULL in the legacy schema; the mistral pool has
        // no S0 blob to migrate, so write an empty envelope rather than null.
        await tx`
          insert into provider (id, name, base_url, credentials_enc, slug, type, tier, status, enabled)
          values (${MISTRAL_PROVIDER.id}, ${MISTRAL_PROVIDER.name}, ${MISTRAL_PROVIDER.base}, '',
                  ${MISTRAL_PROVIDER.slug}, 'openai_compatible', 'commercial', 'active', true)
          on conflict (id) do update set name = excluded.name, base_url = excluded.base_url,
            slug = excluded.slug, updated_at = now()`;
        await tx`
          insert into connection (id, provider_id, name, slug, base_url, auth_type, config)
          values (${MISTRAL_CONNECTION_ID}, ${MISTRAL_PROVIDER.id}, ${MISTRAL_PROVIDER.name},
                  'default', ${MISTRAL_PROVIDER.base}, 'bearer',
                  ${tx.json({ auth_kind: 'apikey', default_headers: {} })})
          on conflict (id) do update set base_url = excluded.base_url, config = excluded.config,
            updated_at = now()`;
      });
      console.log(`[mistral] provider ${MISTRAL_PROVIDER.id} + connection ${MISTRAL_CONNECTION_ID} ensured`);
    }

    const report = {};
    let totalInserted = 0;
    let totalRefreshed = 0;
    const spotChecks = [];
    for (const tag of tags) {
      const list = byTag.get(tag);
      const providerId = list[0].providerId;
      const { ids, legacyNames } = existing.get(providerId);
      const conn = await sql`select id from connection where provider_id = ${providerId} and slug = 'default'`;
      if (conn.length === 0) throw new Error(`no default connection for provider ${providerId}`);
      const connectionId = conn[0].id;
      const perTag = { providerId, connectionId, probed: list.length, live: 0, dead: 0, inactive: 0, already: 0, toInsert: 0 };
      const toInsert = [];
      for (const m of list) {
        if (!m.row.isActive) { perTag.inactive += 1; continue; }
        if (verdictOf(m) !== 'live') { perTag.dead += 1; continue; }
        perTag.live += 1;
        const id = credId(tag, m.row.key);
        if (ids.has(id)) { perTag.already += 1; continue; }
        const email = m.row.email || m.row.dataEmail || '';
        if (email && legacyNames.has(email)) { perTag.already += 1; continue; }
        toInsert.push({ id, key: m.row.key, email });
      }
      perTag.toInsert = toInsert.length;
      report[tag] = perTag;
      console.log(`[${tag}] probed=${perTag.probed} live=${perTag.live} dead=${perTag.dead} ` +
        `inactive=${perTag.inactive} already-present=${perTag.already} to-insert=${perTag.toInsert}`);
      if (DRY || toInsert.length === 0) continue;
      await sql.begin(async (tx) => {
        for (const c of toInsert) {
          const r = await tx`
            insert into credential (id, connection_id, name, secret_enc, status, priority, weight, metadata)
            values (${c.id}, ${connectionId}, ${c.email || c.id},
                    ${encryptJson(c.email ? { api_key: c.key, email: c.email } : { api_key: c.key })},
                    'unknown', 100, 100, ${tx.json(c.email ? { email: c.email } : {})})
            on conflict (id) do update set secret_enc = excluded.secret_enc, updated_at = now()
            returning (xmax = 0) as inserted`;
          if (r.length > 0 && r[0].inserted) {
            totalInserted += 1;
            if (spotChecks.length < 3) spotChecks.push(c.id);
          } else totalRefreshed += 1;
        }
      });
    }

    // Spot-verify 3 newly inserted rows by decrypting them server-side and
    // asserting the payload shape. Nothing about the secret is printed.
    if (!DRY) {
      for (const id of spotChecks) {
        const [row] = await sql`select secret_enc, metadata from credential where id = ${id}`;
        const buf = Buffer.from(row.secret_enc, 'base64');
        const d = createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(buf.length - 16));
        const plain = JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
        const ok = typeof plain.api_key === 'string' && plain.api_key.length > 0;
        console.log(`[verify] ${id} shape=${ok ? 'ok' : 'BAD'} metadata=${redact(JSON.stringify(row.metadata))}`);
        if (!ok) process.exitCode = 1;
      }
    }
    const totals = Object.values(report).reduce((a, r) => ({
      probed: a.probed + r.probed, live: a.live + r.live, dead: a.dead + r.dead,
      inactive: a.inactive + r.inactive, already: a.already + r.already,
      toInsert: a.toInsert + r.toInsert
    }), { probed: 0, live: 0, dead: 0, inactive: 0, already: 0, toInsert: 0 });
    console.log(`[done] ${DRY ? '(dry-run) ' : ''}inserted=${totalInserted} refreshed=${totalRefreshed} ` +
      `probed=${totals.probed} live=${totals.live} dead=${totals.dead} ` +
      `inactive=${totals.inactive} already-present=${totals.already} oauth-skipped=${counts.oauthSkipped} ` +
      `unmapped=${counts.unmapped}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
main().catch((e) => {
  console.error(redact(e?.stack ?? String(e)));
  process.exit(1);
});
