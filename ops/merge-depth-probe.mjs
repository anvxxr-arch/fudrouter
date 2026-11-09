#!/usr/bin/env node
// merge-depth-probe.mjs — prove a proposed (canonical model x provider) pair
// with ONE real chat completion before it is published as a provider_model row.
//
// Why a chat probe and not GET /models: an aggregator lists what it SELLS, not
// what a pooled key may call. Publishing an unproven pair puts a row in the
// candidate fan-out that 402/404s at request time. `/models` membership is the
// candidate filter, never the proof.
//
// Invariant this tool does NOT claim: one 2xx proves the mapping RESOLVES. It
// says nothing about reliability or sustained availability — that stays with
// model_verification / request_attempt history.
//
// Usage:
//   set -a && . ./.env && set +a
//   node ops/merge-depth-probe.mjs /tmp/an/plan.json [/tmp/an/probe.json]
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import postgres from 'postgres';

const PLAN = process.argv[2] || '/tmp/an/plan.json';
const OUT = process.argv[3] || '/tmp/an/probe.json';
const CONC = Number(process.env.PROBE_CONCURRENCY || 4);
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 60_000);

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
const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));

async function keysFor(provider) {
  const rows = await sql`
    select cr.id, cr.secret_enc from credential cr
      join connection cn on cn.id = cr.connection_id
     where cn.provider_id = ${provider}
       and cr.status not in ('disabled','invalid')
       and (cr.cooldown_until is null or cr.cooldown_until <= now())
       and cr.secret_enc is not null
     order by (cr.status = 'healthy') desc, cr.updated_at desc nulls last
     limit 3`;
  return rows.map((r) => ({ id: r.id, key: decrypt(r.secret_enc) })).filter((r) => r.key);
}

async function probe(base, key, upstream) {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: upstream, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.text().catch(() => '');
    return { http: res.status, ok: res.ok, body: body.slice(0, 240) };
  } catch (e) {
    return { http: 0, ok: false, body: String(e?.name || e) };
  }
}

const jobs = [];
for (const p of plan) {
  if (!p.plan) continue;
  for (const pair of p.plan) {
    if (pair.provider_model_row) continue;
    jobs.push({ provider: p.provider, base: p.base, upstream: pair.upstream, canonical_slug: pair.canonical_slug, canonical_id: pair.canonical_id });
  }
}

const results = [];
const keyCache = new Map();
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    if (!keyCache.has(job.provider)) keyCache.set(job.provider, await keysFor(job.provider));
    const keys = keyCache.get(job.provider);
    let verdict = { http: 0, ok: false, body: 'no usable credential' };
    let usedKey = null;
    for (const k of keys) {
      verdict = await probe(job.base, k.key, job.upstream);
      usedKey = k.id;
      if (verdict.http === 401 || verdict.http === 403) continue; // dead key, try the next
      break;
    }
    results.push({ ...job, key: usedKey, ...verdict });
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} ${verdict.http} ${job.provider} ${job.upstream} -> ${job.canonical_slug}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
results.sort((a, b) => (a.provider + a.upstream).localeCompare(b.provider + b.upstream));
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const ok = results.filter((r) => r.ok).length;
console.log(`\n${ok}/${results.length} pairs proved with one chat request (1x max_tokens=1).`);
await sql.end();
