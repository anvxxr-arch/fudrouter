#!/usr/bin/env node
/**
 * Verify ONLY the slugs the reconcile touched (19 new + 4 revived) actually answer
 * through the live router — DB state and /v1/models presence are not proof that a
 * request is routable.
 *
 * Usage: node ops/crowllm-verify-reconciled.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8100';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';

const SLUGS = [
  'qwen-3.6-plus:free', 'qwen-3.8-max:free', 'gemini-2.0-flash:free', 'gemini-2.5-pro:free',
  'gemini-3-flash:free', 'gemini-3-pro:free', 'gemini-3.1-pro:free', 'gemini-3.5-flash:free',
  'gemini-3.7-flash:free', 'gemini-3.8-flash:free', 'muse-spark-1.1:free', 'minimax-m2.5:free',
  'mistral-medium-3.5:free', 'gpt-4.1-mini:free', 'gpt-4o-mini:free', 'gpt-4o:free',
  'gpt-5.6-sol:free', 'o3:free', 'o4-mini:free',
  // the 4 revived shared rows
  'dots-3-note-preview:free', 'north-mini-code:free',
  'nemotron-3-super-120b-a12b:free', 'nemotron-3-ultra-550b-a55b:free',
];

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

const psql = (q) =>
  execSync(`docker exec postgre psql -U postgres -d fudrouter -tAc ${JSON.stringify(q)}`, { stdio: 'pipe' })
    .toString().trim();

psql(`insert into api_key (id,user_id,name,prefix,key_hash,status) values ('${keyId}','${USER_ID}','verify-reconciled','${prefix}','${keyHash}','active')`);
const cleanup = () => { try { psql(`delete from api_key where id='${keyId}'`); } catch {} };
process.on('exit', cleanup);

let ok = 0, okR = 0;
const bad = [];
for (const m of SLUGS) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 96 }),
      signal: AbortSignal.timeout(90_000),
    });
    const j = await r.json().catch(() => null);
    const ch = j?.choices?.[0] ?? {};
    const txt = (ch?.message?.content ?? '').trim();
    const rsn = (ch?.message?.reasoning ?? '').trim();
    const ms = Date.now() - t0;
    if (r.status === 200 && txt) { ok++; console.log(`OK   ${m.padEnd(36)} ${ms}ms "${txt.slice(0, 24)}"`); }
    else if (r.status === 200 && rsn && ch?.finish_reason === 'length') { okR++; console.log(`OK*  ${m.padEnd(36)} ${ms}ms reasoning-only`); }
    else { bad.push([m, r.status, JSON.stringify(j).slice(0, 80)]); console.log(`--   ${m.padEnd(36)} ${r.status} ${JSON.stringify(j).slice(0, 80)}`); }
  } catch (e) {
    bad.push([m, 'ERR', e.message.slice(0, 60)]);
    console.log(`--   ${m.padEnd(36)} ERR ${e.message.slice(0, 60)}`);
  }
  await new Promise((s) => setTimeout(s, 900));
}
console.log(`\n=== ${ok} answered + ${okR} reasoning-only = ${ok + okR}/${SLUGS.length} of the reconciled slugs WORK through the router ===`);
if (bad.length) { console.log('\nnot working:'); for (const [m, c, d] of bad) console.log(`   ${m.padEnd(36)} ${c} ${d}`); }
cleanup();
