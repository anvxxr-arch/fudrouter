#!/usr/bin/env node
// ops/catalog-discover.mjs — ask a provider's OWN /models endpoint what it serves
// right now, using a live key from the pool, and diff that against the
// provider_model rows fudrouter has published.
//
// Why: the router only routes a `provider_model` row. A provider can hold
// thousands of live keys and still be dead weight if its catalogue was never
// (re)discovered — or if the upstream renamed/retired the models the rows point
// at (a green credential plus a stale model id = 404/502 to the caller, blamed on
// the pool).
//
// Usage:
//   set -a && . /home/dwizzy/fudrouter/.env && set +a
//   node ops/catalog-discover.mjs <provider_id> [--json]
//
// Read-only: prints upstream ids, published ids, and the set difference both ways.
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const provider = argv.find((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');
if (!provider) {
  console.error('usage: catalog-discover.mjs <provider_id> [--json]');
  process.exit(2);
}

const key = process.env.CREDENTIALS_MASTER_KEY;
if (!key) throw new Error('CREDENTIALS_MASTER_KEY is not set');
const master = Buffer.from(key, 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must base64-decode to 32 bytes');

function decrypt(enc) {
  const raw = Buffer.from(enc, 'base64');
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const d = createDecipheriv('aes-256-gcm', master, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const [conn] = await sql`
  select cn.id, p.base_url from connection cn join provider p on p.id = cn.provider_id
   where cn.provider_id = ${provider} limit 1`;
if (!conn) throw new Error(`no connection for provider ${provider}`);
const base = String(conn.base_url).replace(/\/+$/, '');

const published = await sql`
  select m.slug, pm.enabled, pm.status
    from provider_model pm join model m on m.id = pm.model_id
   where pm.provider_id = ${provider}`;

// Try live keys newest-first until /models answers — a key that reads the
// catalogue is not necessarily a key that can chat, but it proves reachability.
const creds = await sql`
  select cr.id, cr.secret_enc from credential cr join connection cn on cn.id = cr.connection_id
   where cn.provider_id = ${provider} and cr.status = 'healthy' and cr.secret_enc is not null
   order by cr.updated_at desc nulls last limit 12`;

let upstream = null, usedKey = null, rawStatus = null, err = null;
for (const row of creds) {
  let apiKey;
  try { const s = decrypt(row.secret_enc); apiKey = s.api_key || s.access_token; } catch { continue; }
  if (!apiKey) continue;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const resp = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    clearTimeout(t);
    rawStatus = resp.status;
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      const list = body?.data ?? body?.models ?? (Array.isArray(body) ? body : null);
      if (Array.isArray(list)) {
        upstream = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean);
        usedKey = row.id;
        break;
      }
      err = 'unrecognised /models shape';
    } else {
      err = `HTTP ${resp.status}`;
    }
  } catch (e) { clearTimeout(t); err = String(e?.name || e); }
}

const pubIds = new Set(published.map((r) => r.slug));
const upIds = new Set(upstream || []);
const missing = (upstream || []).filter((id) => !pubIds.has(id));            // upstream has, we don't publish
const stale = published.filter((r) => !upIds.has(r.slug)).map((r) => r.slug); // we publish, upstream doesn't list

const out = {
  provider, base, key_used: usedKey, upstream_http: rawStatus, upstream_error: err,
  upstream_count: upstream?.length ?? 0, published_count: published.length,
  missing_from_router: missing, published_but_not_upstream: stale,
};
if (asJson) { console.log(JSON.stringify(out, null, 2)); await sql.end(); process.exit(0); }

console.log(`provider=${provider} base=${base}`);
console.log(`key=${usedKey ?? '(none answered)'} upstream_http=${rawStatus} ${err ? `err=${err}` : ''}`);
console.log(`upstream models: ${upstream?.length ?? 0} | published rows: ${published.length}`);
if (missing.length) {
  console.log(`\n[upstream has, router does NOT publish] (${missing.length}) — first 25:`);
  for (const id of missing.slice(0, 25)) console.log(`  + ${id}`);
}
if (stale.length) {
  console.log(`\n[published, upstream does NOT list] (${stale.length}) — first 25:`);
  for (const id of stale.slice(0, 25)) console.log(`  - ${id}`);
}
if (upstream && !missing.length && !stale.length) console.log('\ncatalogue in sync ✓');
await sql.end();
