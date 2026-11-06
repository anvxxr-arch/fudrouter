#!/usr/bin/env node
/**
 * fox-crowllm-e2e.mjs — prove crowllm models WORK through the fudrouter, not just that
 * they are published. Mints a temp API key (sha256 stored, same pattern as
 * ops/poll-models.mjs), probes a sample of crowllm's :free models through the live
 * router, revokes the key, and prints a per-model verdict.
 *
 * Usage: node fox-crowllm-e2e.mjs [n] [baseUrl]
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const N = Number(process.argv[2] ?? 8);
const BASE = process.argv[3] ?? 'http://127.0.0.1:8100';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

const psql = (q) => execSync(`docker exec postgre psql -U postgres -d fudrouter -tAc ${JSON.stringify(q)}`, { stdio: 'pipe' }).toString().trim();

psql(`insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}','${USER_ID}','fox-crowllm-e2e','${prefix}','${keyHash}','active')`);
const cleanup = () => { try { psql(`delete from api_key where id='${keyId}'`); } catch {} };
process.on('exit', cleanup);

const models = psql(`select m.slug from provider_model pm join model m on m.id=pm.model_id where pm.provider_id='prv_crowllm' and pm.enabled order by m.slug`).split('\n').filter(Boolean);
console.log(`crowllm provider_models: ${models.length}`);
const pick = models.slice(0, N);
console.log(`probing ${pick.length} through ${BASE}\n`);

let ok = 0, okReasoning = 0;
for (const m of pick) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 96 }),
      signal: AbortSignal.timeout(90_000)
    });
    const j = await r.json().catch(() => null);
    const ch = j?.choices?.[0] ?? {};
    const txt = (ch?.message?.content ?? '').trim().slice(0, 40);
    const reasoning = (ch?.message?.reasoning ?? '').trim();
    const ms = Date.now() - t0;
    if (r.status === 200 && txt) {
      ok++; console.log(`OK   ${m.padEnd(46)} ${ms}ms  "${txt}"`);
    } else if (r.status === 200 && reasoning && ch?.finish_reason === 'length') {
      // reasoning model: it spent the whole token budget thinking, so content is
      // null and finish_reason is 'length'. The path is proven — a real caller
      // just needs a bigger max_tokens. NOT a failure.
      okReasoning++; console.log(`OK*  ${m.padEnd(46)} ${ms}ms  reasoning-only, ${reasoning.length} chars of thought`);
    } else {
      console.log(`--   ${m.padEnd(46)} ${r.status} ${JSON.stringify(j).slice(0, 110)}`);
    }
  } catch (e) {
    console.log(`--   ${m.padEnd(46)} ERR ${e.message.slice(0, 70)}`);
  }
  await new Promise((s) => setTimeout(s, 800));
}
console.log(`\n=== ${ok}/${pick.length} answered, +${okReasoning} reasoning-only (path proven) => ${ok + okReasoning}/${pick.length} WORKED through the router ===`);
cleanup();
