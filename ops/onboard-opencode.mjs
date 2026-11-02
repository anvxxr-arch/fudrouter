#!/usr/bin/env node
// ops/onboard-opencode.mjs — onboard OpenCode Zen accounts into fudrouter.
//
// OpenCode Zen gives ~100 free requests/day PER ACCOUNT (OAuth device flow),
// gated per-account — so capacity scales exactly with account count. This
// script registers the provider/connection and imports accounts minted by
// ops/opencode-farm.mjs as credential rows (spec §4: one account = one row).
//
// The data plane's Pool already round-robins these rows and parks a 401/403
// account (pool.go MarkFailed + parkCredential). The ONLY thing farm-specific
// here is the secret shape: an OAuth account JSON
//   {"email","access_token","refresh_token","id_token","expired"}
// which accountFromSecret (targets.go) already reads back. A static api_key
// shape is also supported for paid models, but free models are OAuth-only.
//
// Usage:
//   set -a && . .env && set +a && node ops/onboard-opencode.mjs [--dry-run]
// Knobs: OPENCODE_ACCOUNTS (jsonl path), OPENCODE_PROBE_CONCURRENCY.
//
// Idempotent: credential id = cred_opencode_<sha256(marker)[:16]>, written once.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const PROVIDER_ID = 'prv_opencode';
const CONNECTION_ID = 'con_prv_opencode-default';
const BASE = 'https://opencode.ai/zen/v1';
// OpenCode Zen rejects a missing/odd User-Agent on some paths; the CLI ships
// `opencode/<ver>`. Default headers are folded by the data plane (reservedHeaders).
const DEFAULT_HEADERS = { 'User-Agent': 'opencode/1.18.4' };
// The refresh_token grant endpoint + public client_id, so the data plane's
// OAuthRefresher (pool.go) exchanges opencode access tokens against the RIGHT
// token endpoint instead of the xAI default. client_id is the public CLI
// client (not a secret) — same one the device flow uses.
const OAUTH_ENDPOINT = 'https://console.opencode.ai/auth/device/token';
const OAUTH_CLIENT_ID = 'opencode-cli';
const ACCOUNTS_FILE = process.env.OPENCODE_ACCOUNTS ??
  '/home/dwizzy/farm/providers/opencode-farm/out/opencode_accounts.jsonl';

// The free-tier model list, verified live against /v1/models (2026-10-29).
// `-free` suffix = zero-cost, gated per-account (~100 req/day). big-pickle is
// owned_by=opencode and served free at signup. Paid models are deliberately
// NOT listed here — an OAuth free account cannot serve them.
const FREE_MODELS = [
  { slug: 'big-pickle', id: 'big-pickle' },
  { slug: 'beam-free', id: 'beam-free' },
  { slug: 'flint-40b-free', id: 'flint-40b-free' },
  { slug: 'mimo-v2.6-flash-free', id: 'mimo-v2.6-flash-free' },
  { slug: 'nemotron-3.5-super-vl-free', id: 'nemotron-3.5-super-vl-free' },
  { slug: 'nemotron-3.5-lightning-free', id: 'nemotron-3.5-lightning-free' },
  { slug: 'jev-1.13-free', id: 'jev-1.13-free' },
  { slug: 'deepseek-v4.1-flash-free', id: 'deepseek-v4.1-flash-free' },
  { slug: 'glm-5.3-flash-free', id: 'glm-5.3-flash-free' }
];

const DRY = process.argv.includes('--dry-run');
const PROBE_CONC = Number(process.env.OPENCODE_PROBE_CONCURRENCY ?? 8);

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
const credId = (marker) => 'cred_opencode_' + createHash('sha256').update(marker).digest('hex').slice(0, 16);

function loadAccounts() {
  let text;
  try {
    text = readFileSync(ACCOUNTS_FILE, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${ACCOUNTS_FILE}: ${e.message}`);
  }
  const out = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    // account marker: prefer email, else access_token/refresh prefix. Unique.
    const acc = row.access_token || row.refresh_token;
    const marker = row.email || (acc ? String(acc).slice(0, 32) : null);
    if (!marker || seen.has(marker)) continue;
    seen.add(marker);
    if (!row.access_token && !row.refresh_token && !row.api_key) continue;
    out.push(row);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// A 401/403 means THIS token is refused (dead/expired); 200 means accepted;
// anything else (429/5xx/timeout) is not a verdict on the account. Probe the
// cheapest auth-required path — /models is noauth, use a 1-token chat.
const LIVE = 'live', REJECTED = 'rejected', UNREACHABLE = 'unreachable';
async function probeAccount(acc) {
  const token = acc.access_token || acc.api_key;
  if (!token) return UNREACHABLE;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        ...DEFAULT_HEADERS
      },
      body: JSON.stringify({ model: 'beam-free', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(25_000)
    });
    return res.status === 200 ? LIVE
      : (res.status === 401 || res.status === 403) ? REJECTED : UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const all = loadAccounts();
    if (all.length === 0) throw new Error(`no accounts parsed from ${ACCOUNTS_FILE}`);
    console.log(`[opencode] accounts in file: ${all.length}`);

    const verdicts = await mapLimit(all, PROBE_CONC, probeAccount);
    const live = all.filter((_, i) => verdicts[i] === LIVE);
    const rejected = all.filter((_, i) => verdicts[i] === REJECTED);
    console.log(`[opencode] live now: ${live.length}  rejected: ${rejected.length}  unreachable: ${all.length - live.length - rejected.length}`);

    if (DRY) { console.log('--dry-run: no writes'); return; }

    await sql.begin(async (tx) => {
      // Provider + connection upsert (mirrors onboard-farm.mjs).
      const [prov] = await tx`
        insert into provider (id, name, slug, base_url, credentials_enc, status, tier, type, description, enabled)
        values (${PROVIDER_ID}, 'OpenCode Zen', 'opencode', ${BASE},
                ${encryptJson({ auth_kind: 'oauth', default_headers: DEFAULT_HEADERS })},
                'active', 'commercial', 'gateway', 'OpenCode Zen free-tier models via OAuth', true)
        on conflict (id) do update set base_url = excluded.base_url, updated_at = now()
        returning id`;
      if (!prov) throw new Error('provider upsert failed');

      const [conn] = await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, config, enabled, health_status)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, 'OpenCode Zen default', 'default', ${BASE},
                'oauth', ${tx.json({ auth_kind: 'oauth', default_headers: DEFAULT_HEADERS, oauth_endpoint: OAUTH_ENDPOINT, oauth_client_id: OAUTH_CLIENT_ID })}, true, 'unknown')
        on conflict (id) do update set base_url = excluded.base_url, config = excluded.config, updated_at = now()
        returning id`;
      if (!conn) throw new Error('connection upsert failed');

      // Free-tier models: canonical `model` row + `provider_model` mapping.
      for (const m of FREE_MODELS) {
        await tx`
          insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
          values (${'mdl_' + m.slug}, ${PROVIDER_ID}, ${m.id}, ${m.slug}, null, 0, 0, 'USD', 'active')
          on conflict (id) do update set status = 'active', updated_at = now()`;
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pm_opencode_' + m.slug}, ${'mdl_' + m.slug}, ${PROVIDER_ID}, ${CONNECTION_ID},
                  ${m.id}, true, 'available')
          on conflict (id) do update set enabled = true, status = 'available', updated_at = now()`;
      }

      // OAuth account secret shape — matches accountFromSecret in targets.go.
      const secretOf = (a) => ({
        email: a.email || '',
        access_token: a.access_token || '',
        refresh_token: a.refresh_token || '',
        id_token: a.id_token || '',
        expired: a.expired || a.expires_at || '2099-01-01T00:00:00Z'
      });

      let added = 0;
      for (const a of live) {
        const marker = a.email || String(a.access_token || a.refresh_token || '').slice(0, 32);
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${credId(marker)}, ${CONNECTION_ID}, ${a.email || (a.api_key ? 'key:' + String(a.api_key).slice(0, 8) : credId(marker))},
                  ${encryptJson(secretOf(a))}, 'healthy',
                  ${tx.json(Object.assign({}, a.metadata || {}, a.email ? { email: a.email } : {}))})
          on conflict (id) do update set
            secret_enc = excluded.secret_enc,
            status = 'healthy',
            updated_at = now()
          returning id`;
        if (r.length > 0) added += 1;
      }
      let invalidated = 0;
      for (const a of rejected) {
        const marker = a.email || String(a.access_token || a.refresh_token || '').slice(0, 32);
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${credId(marker)}, ${CONNECTION_ID}, ${a.email || credId(marker)},
                  ${encryptJson(secretOf(a))}, 'invalid', ${tx.json({})})
          on conflict (id) do update set status = 'invalid', updated_at = now()
          where credential.status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      console.log(`[opencode] credentials: ${added} live, ${invalidated} invalid`);
    });

    const [cc] = await sql`
      select count(*)::int n, count(*) filter (where cr.status in ('healthy','unknown'))::int usable
      from credential cr join connection cn on cn.id = cr.connection_id
      where cn.provider_id = ${PROVIDER_ID}`;
    console.log(`[opencode] pool now: ${cc.n} credentials (usable=${cc.usable})`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });