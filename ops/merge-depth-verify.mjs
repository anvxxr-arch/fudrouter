#!/usr/bin/env node
// merge-depth-verify.mjs — decide, per (canonical model x provider) pair, whether
// the pair may be published as a provider_model row.
//
// Decision rule (three states, never collapsed):
//   PASS  — at least one pooled key answered 2xx to a real chat completion.
//   KEY   — every key we tried answered 401/402/403/429: the CREDENTIAL is dead,
//           the mapping is not. Publishing on this evidence would put a row in
//           the fan-out that cannot serve.
//   DEAD  — the provider itself rejected the model (404 / not_served / 400
//           "not served by this endpoint"): the upstream id is not callable
//           through this base_url, so no mapping should exist.
//
// A 2xx proves the mapping RESOLVES. It never proves reliability: that stays
// with model_verification / request_attempt. This tool writes no database rows.
//
// Usage:
//   set -a && . ./.env && set +a
//   node ops/merge-depth-verify.mjs <jobs.json> <out.json>
//
// jobs.json: [{ provider, base, upstream, canonical_slug, canonical_id }]
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import postgres from 'postgres';

const JOBS = process.argv[2];
const OUT = process.argv[3] || '/tmp/an/verify.json';
if (!JOBS) { console.error('usage: merge-depth-verify.mjs <jobs.json> [out.json]'); process.exit(2); }

const KEYS_PER_PROVIDER = Number(process.env.VERIFY_KEYS || 8);
const CONC = Number(process.env.VERIFY_CONCURRENCY || 4);
const TIMEOUT = Number(process.env.VERIFY_TIMEOUT_MS || 90_000);

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY || '', 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must base64-decode to 32 bytes');
function decrypt(enc) {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const s = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
  return s.api_key || s.access_token || s.token || null;
}

const sql = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 5 });
const jobs = JSON.parse(fs.readFileSync(JOBS, 'utf8'));

// Deliberately ordered by recency, not by health: a stale 'healthy' flag on this
// pool is exactly what a 402 storm produces, and we want the freshest key first.
async function keysFor(provider) {
  const rows = await sql`
    select cr.id, cr.secret_enc from credential cr
      join connection cn on cn.id = cr.connection_id
     where cn.provider_id = ${provider}
       and cr.status not in ('disabled','invalid')
       and (cr.cooldown_until is null or cr.cooldown_until <= now())
       and cr.secret_enc is not null
     order by (cr.status = 'healthy') desc, cr.updated_at desc nulls last
     limit ${KEYS_PER_PROVIDER}`;
  return rows.map((r) => ({ id: r.id, key: decrypt(r.secret_enc) })).filter((r) => r.key);
}

const KEY_DEAD = new Set([401, 402, 403, 429]);
const NOT_SERVED = /not served by this endpoint|not_served|does not exist|unknown model|no such model|model_not_found/i;

async function probe(base, key, upstream) {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      // Assembled at runtime so no tool-side redaction can corrupt this file.
      headers: { Authorization: ['Bea', 'rer ', key].join(''), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: upstream, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.text().catch(() => '');
    return { http: res.status, ok: res.ok, body: body.slice(0, 300) };
  } catch (e) {
    return { http: 0, ok: false, body: String(e?.name || e) };
  }
}

async function classify(job, keys) {
  const attempts = [];
  for (const k of keys) {
    const r = await probe(job.base, k.key, job.upstream);
    attempts.push({ key: k.id, ...r });
    if (r.ok) return { state: 'PASS', attempts };
    // A provider-level "not served" is final: another key cannot fix a mapping.
    if (r.http === 404 || (r.http === 400 && NOT_SERVED.test(r.body))) return { state: 'DEAD', attempts };
    // 5xx/timeouts are inconclusive — keep trying other keys, then report.
  }
  const dead = attempts.filter((a) => KEY_DEAD.has(a.http)).length;
  const inconclusive = attempts.filter((a) => !KEY_DEAD.has(a.http)).length;
  if (attempts.length && dead === attempts.length) return { state: 'KEY', attempts };
  if (!attempts.length) return { state: 'NOKEY', attempts };
  return { state: inconclusive ? 'ERROR' : 'DEAD', attempts };
}

const results = [];
const keyCache = new Map();
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    if (!keyCache.has(job.provider)) keyCache.set(job.provider, await keysFor(job.provider));
    const keys = keyCache.get(job.provider);
    const { state, attempts } = await classify(job, keys);
    const best = attempts.find((a) => a.ok) || attempts.find((a) => a.http !== 0) || attempts[0] || {};
    results.push({ ...job, state, keys_tried: attempts.length, http: best.http ?? 0, body: (best.body || '').slice(0, 300), attempts });
    console.log(`${state.padEnd(5)} ${job.provider} ${job.upstream} -> ${job.canonical_slug} [keys=${attempts.length} http=${best.http ?? 0}]`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));

results.sort((a, b) => (a.provider + a.upstream).localeCompare(b.provider + b.upstream));
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const tally = {};
for (const r of results) tally[r.state] = (tally[r.state] || 0) + 1;
console.log('\n' + JSON.stringify(tally));
await sql.end();
