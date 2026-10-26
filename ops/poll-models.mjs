#!/usr/bin/env node
/**
 * ops/poll-models.mjs — hourly truth poll: published vs WORKED models.
 *
 * "Published" = what /v1/models serves right now (catalog gate: live creds).
 * "Worked"    = published model that actually returns a completion when
 *               probed through the public router — i.e. BISA DIPAKE.
 * A model that is published but fails the probe is exactly the "percuma ada
 * tapi gabisa dipake" case this poll exists to count.
 *
 * Creates a temporary API key (sk-ar-<prefix>_<secret>, sha256 stored),
 * probes every published model with a 16-token completion, appends one JSONL
 * snapshot to ops/data/model-poll.jsonl, revokes the key. Read-only wrt
 * provider credentials; the only writes are the temp key + the log.
 *
 * Usage: node ops/poll-models.mjs [--base https://fudrouter.my.id]
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'https://fudrouter.my.id';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3'; // Diag
const CONCURRENCY = 2;
const PACE_MS = 2200;      // stay under the 75 rpm account limit
const TIMEOUT_MS = 35_000;
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const LOG_FILE = path.join(LOG_DIR, 'model-poll.jsonl');

// --- temp key (same pattern as model-sweep.mjs) ----------------------------
let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

execSync(`docker exec postgre psql -U postgres -d fudrouter -c "insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-model-poll', '${prefix}', '${keyHash}', 'active');"`, { stdio: 'pipe' });

const cleanup = () => {
  try {
    execSync(`docker exec postgre psql -U postgres -d fudrouter -c "update api_key set status='revoked', revoked_at=now() where id='${keyId}';"`, { stdio: 'pipe' });
  } catch {}
};
process.on('exit', cleanup);

// --- fetch published catalog ------------------------------------------------
const modelsRes = await fetch(`${BASE}/v1/models`);
if (!modelsRes.ok) {
  console.error(`FATAL: /v1/models -> HTTP ${modelsRes.status}`);
  process.exit(1);
}
const catalog = await modelsRes.json();
const models = (catalog.data ?? []).map((m) => m.id).sort();

// --- probe ------------------------------------------------------------------
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < models.length) {
    const model = models[cursor++];
    const started = Date.now();
    let verdict = 'worked';
    let httpStatus = 0;
    let error = null;
    try {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      httpStatus = res.status;
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          verdict = 'failed';
          error = '2xx but empty completion';
        }
      } else {
        verdict = 'failed';
        const text = await res.text().catch(() => '');
        error = text.slice(0, 160).replace(/\s+/g, ' ');
      }
    } catch (e) {
      verdict = 'failed';
      error = e.name === 'TimeoutError' ? 'timeout' : String(e.message ?? e).slice(0, 160);
    }
    results.push({ model, verdict, httpStatus, error, latencyMs: Date.now() - started });
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// --- snapshot ---------------------------------------------------------------
const worked = results.filter((r) => r.verdict === 'worked');
const failed = results.filter((r) => r.verdict === 'failed');
const byStatus = {};
for (const f of failed) {
  const k = f.httpStatus > 0 ? `HTTP ${f.httpStatus}` : f.error.split(' ')[0];
  byStatus[k] = (byStatus[k] ?? 0) + 1;
}

const snapshot = {
  ts: new Date().toISOString(),
  published: models.length,
  worked: worked.length,
  failed: failed.length,
  failBreakdown: byStatus,
  failures: failed.map((f) => ({ model: f.model, http: f.httpStatus, error: f.error })),
};

mkdirSync(LOG_DIR, { recursive: true });
appendFileSync(LOG_FILE, `${JSON.stringify(snapshot)}\n`);

// --- report -----------------------------------------------------------------
const wib = new Date(Date.now() + 7 * 3600_000);
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${wib.getUTCFullYear()}-${p2(wib.getUTCMonth() + 1)}-${p2(wib.getUTCDate())} ${p2(wib.getUTCHours())}:${p2(wib.getUTCMinutes())} WIB`;

console.log(`🦊 MODEL POLL — ${stamp}`);
console.log(`Published: ${snapshot.published} | Worked: ${snapshot.worked} | Failed: ${snapshot.failed}`);
if (failed.length > 0) {
  const breakdown = Object.entries(byStatus).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} x${v}`).join(', ');
  console.log(`Fail breakdown: ${breakdown}`);
  // Worst offenders first: the models users would actually try.
  console.log(`Failed models: ${failed.slice(0, 15).map((f) => f.model).join(', ')}${failed.length > 15 ? `, +${failed.length - 15} more` : ''}`);
}
const lat = worked.map((w) => w.latencyMs).sort((a, b) => a - b);
if (lat.length > 0) {
  console.log(`Worked latency p50=${lat[Math.floor(lat.length / 2)]}ms max=${lat[lat.length - 1]}ms`);
}
console.log(`Log: ${LOG_FILE}`);
