#!/usr/bin/env node
/**
 * fox-crowllm-retest.mjs — re-probe the models that "failed" the first pass.
 *
 * Two false-negative sources in the first pass:
 *   1. reasoning models (glm-4.6/4.7, beam, flint, xing...) emit a long `reasoning`
 *      trace and only then the answer. With max_tokens=16 the budget is spent on
 *      reasoning → finish_reason='length', content=null → looked like a dead model
 *      while upstream returned 200. Fix: max_tokens=512 and treat a non-empty
 *      `reasoning` field as a live model too.
 *   2. embed-*:free are embedding models; a /chat/completions call is the wrong
 *      probe and they should not be in the chat catalogue at all.
 *
 * Usage: node fox-crowllm-retest.mjs [baseUrl]
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8100';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const LOG = '/home/dwizzy/.hermes/cache/scratch/crowllm_e2e_full.log';

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;
const psql = (q) => execSync(`docker exec postgre psql -U postgres -d fudrouter -tAc ${JSON.stringify(q)}`, { stdio: 'pipe' }).toString().trim();

psql(`insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}','${USER_ID}','fox-crowllm-retest','${prefix}','${keyHash}','active')`);
const cleanup = () => { try { psql(`delete from api_key where id='${keyId}'`); } catch {} };
process.on('exit', cleanup);

// failed model ids from the first pass
const failed = readFileSync(LOG, 'utf8').split('\n')
  .filter((l) => l.startsWith('--'))
  .map((l) => l.slice(2).trim().split(/\s+/)[0])
  .filter(Boolean);
const embed = failed.filter((m) => m.startsWith('embed'));
const chat = failed.filter((m) => !m.startsWith('embed'));
console.log(`failed in pass 1: ${failed.length}  (embed=${embed.length}, chat-candidate=${chat.length})\n`);

let ok = 0;
const stillBad = [];
for (const m of chat) {
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Say the word: PONG' }], max_tokens: 512 }),
      signal: AbortSignal.timeout(120_000)
    });
    const j = await r.json().catch(() => null);
    const c = (j?.choices?.[0]?.message?.content ?? '').trim();
    const rz = (j?.choices?.[0]?.message?.reasoning ?? '').trim();
    const alive = r.status === 200 && (c.length > 0 || rz.length > 0);
    if (alive) { ok++; console.log(`OK  ${m.padEnd(46)} content="${c.slice(0, 30)}" reasoning=${rz.length}c`); }
    else { stillBad.push(m); console.log(`--  ${m.padEnd(46)} ${r.status} ${JSON.stringify(j).slice(0, 100)}`); }
  } catch (e) {
    stillBad.push(m);
    console.log(`--  ${m.padEnd(46)} ERR ${e.message.slice(0, 60)}`);
  }
  await new Promise((s) => setTimeout(s, 900));
}
console.log(`\n=== recovered: ${ok}/${chat.length} of the "failed" chat models actually work ===`);
console.log(`truly dead: ${stillBad.length} ${JSON.stringify(stillBad)}`);
console.log(`embeddings to de-register from chat catalogue: ${embed.length}`);
