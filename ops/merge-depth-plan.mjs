#!/usr/bin/env node
// capture-and-plan.mjs — read-only.
//
// For each provider whose credential pool is big but whose published
// `provider_model` surface is small, capture the provider's OWN upstream
// /models list with one live key, then match every upstream id onto an
// EXISTING canonical model identity in this database (active + chat-capable).
//
// Output is a plan: for each (canonical model, provider) pair, whether a
// provider_model row already exists. Nothing is written.
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import postgres from 'postgres';

const PROVIDERS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!PROVIDERS.length) {
  console.error('usage: capture-and-plan.mjs <provider_id> [...]');
  process.exit(2);
}

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY || '', 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must base64-decode to 32 bytes');
function decrypt(enc) {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
  const s = JSON.parse(plain);
  return s.api_key || s.access_token || s.token || null;
}

const sql = postgres(process.env.DATABASE_URL, { max: 2, idle_timeout: 5 });

const models = await sql`select id, slug, status, provider_id,
  coalesce(capabilities->>'chat','') as chat from model`;
const pms = await sql`select id, model_id, provider_id, provider_model_id, enabled, status, connection_id from provider_model`;
const aliases = await sql`select alias, canonical_model_id from model_slug_alias`;

const byId = new Map(models.map((m) => [m.id, m]));
const aliasOf = new Map(aliases.map((a) => [a.alias, a.canonical_model_id]));

// identity: an alias target when that target is an ACTIVE row (the same rule
// CandidatesBatch applies: `canonical.status='active'`), else the row itself.
function identity(m) {
  const c = aliasOf.get(m.slug);
  if (c && byId.get(c)?.status === 'active') return byId.get(c);
  return m;
}
const canonBySlug = new Map();
for (const m of models) {
  const c = identity(m);
  if (c.status !== 'active') continue;
  if (c.chat === 'false') continue;
  const key = c.slug.toLowerCase();
  if (!canonBySlug.has(key)) canonBySlug.set(key, c);
}

// Upstream ids are namespaced. Strip ONE vendor namespace and the Google
// `models/` prefix — the same prefixes 0026/0028 already treat as namespaces —
// then match the remainder case-insensitively against an existing canonical
// slug. No fuzzy matching: a pair is proposed only on exact (case-folded)
// equality, because a wrong pair routes a chat request into a 404.
const VENDOR = /^(zai-org|minimaxai|deepseek-ai|moonshotai|qwen|meta-llama|google|x-ai|openai|mistralai|nvidia|microsoft|anthropic|models)\//i;
function candidatesFor(upstreamId) {
  const out = [];
  let s = upstreamId.trim();
  const stripped = s.replace(VENDOR, '');
  for (const c of [s, stripped]) out.push(c.toLowerCase());
  return out;
}

const report = [];
for (const provider of PROVIDERS) {
  const [conn] = await sql`
    select cn.id, cn.enabled, cn.health_status, p.base_url, p.status as pstatus, p.enabled as penabled
      from connection cn join provider p on p.id = cn.provider_id
     where cn.provider_id = ${provider} limit 1`;
  if (!conn) { report.push({ provider, error: 'no connection' }); continue; }
  const creds = await sql`
    select cr.id, cr.secret_enc from credential cr
     where cr.connection_id = ${conn.id} and cr.status not in ('disabled','invalid')
       and cr.secret_enc is not null
     order by (cr.status = 'healthy') desc, cr.updated_at desc nulls last limit 5`;

  const base = String(conn.base_url).replace(/\/+$/, '');
  let upstream = null, usedKey = null, http = null, err = null;
  for (const c of creds) {
    let key;
    try { key = decrypt(c.secret_enc); } catch { continue; }
    if (!key) continue;
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      http = res.status;
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const list = body?.data ?? body?.models ?? (Array.isArray(body) ? body : null);
        if (Array.isArray(list)) {
          upstream = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean);
          usedKey = c.id;
          break;
        }
        err = 'unrecognised /models shape';
      } else {
        err = `HTTP ${res.status}`;
      }
    } catch (e) { err = String(e?.name || e); }
  }

  const existing = pms.filter((p) => p.provider_id === provider);
  const existingModelIds = new Set(existing.map((p) => p.model_id));
  const plan = [];
  for (const up of upstream || []) {
    const keys = candidatesFor(up);
    let hit = null, matchedBy = null;
    for (const k of keys) {
      const c = canonBySlug.get(k);
      if (c) { hit = c; matchedBy = k; break; }
    }
    if (!hit) continue;
    // Already published for this provider (any spelling)?
    const already = existing.filter((p) => {
      const pmModel = byId.get(p.model_id);
      return p.model_id === hit.id || (pmModel && identity(pmModel).id === hit.id);
    });
    plan.push({
      upstream: up,
      canonical_id: hit.id,
      canonical_slug: hit.slug,
      matched_by: matchedBy,
      provider_model_row: already.length
        ? { id: already[0].id, upstream: already[0].provider_model_id, enabled: already[0].enabled, status: already[0].status }
        : null,
    });
  }
  report.push({
    provider, base, connection: conn.id, connection_enabled: conn.enabled,
    provider_status: conn.pstatus, provider_enabled: conn.penabled,
    key_used: usedKey, upstream_http: http, upstream_error: err,
    upstream_count: upstream?.length ?? 0,
    published_count: existing.length,
    matched: plan.length,
    new_pairs: plan.filter((p) => !p.provider_model_row).length,
    plan,
  });
}

fs.writeFileSync('/tmp/an/plan.json', JSON.stringify(report, null, 2));
for (const r of report) {
  if (r.error) { console.log(`${r.provider}: ERROR ${r.error}`); continue; }
  console.log(`${r.provider}: upstream=${r.upstream_count} http=${r.upstream_http} published=${r.published_count} matched=${r.matched} new=${r.new_pairs}`);
  for (const p of r.plan) {
    console.log(`   ${p.provider_model_row ? 'have' : 'NEW '} ${p.upstream}  ->  ${p.canonical_slug}`);
  }
}
await sql.end();
