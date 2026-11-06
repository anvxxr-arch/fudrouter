#!/usr/bin/env node
/**
 * Fast router-health probe: take the N slugs crowllm serves and report the
 * status histogram through the live router. Used to tell "the upstream is
 * degrading" apart from "our router/pool is broken", because the same slug can
 * answer 200 direct and 503 through the router within the same minute.
 *
 * Usage: node ops/crowllm-probe-sample.mjs [n] [gapMs]
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8100';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const N = Number(process.argv[2] ?? 12);
const GAP = Number(process.argv[3] ?? 1200);

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyId = `key_${randomBytes(8).toString('hex')}`;
const psql = (q) => execSync(`docker exec postgre psql -U postgres -d fudrouter -tAc ${JSON.stringify(q)}`, { stdio: 'pipe' }).toString().trim();
psql(`insert into api_key (id,user_id,name,prefix,key_hash,status) values ('${keyId}','${USER_ID}','probe-sample','${prefix}','${createHash('sha256').update(secret).digest('hex')}','active')`);
process.on('exit', () => { try { psql(`delete from api_key where id='${keyId}'`); } catch {} });

const all = psql(`select m.slug from provider_model pm join model m on m.id=pm.model_id where pm.provider_id='prv_crowllm' and pm.enabled and m.status='active' order by m.slug`).split('\n').filter(Boolean);
// evenly spread the sample across the whole catalogue, not just the first N
const step = Math.max(1, Math.floor(all.length / N));
const pick = Array.from({ length: Math.min(N, all.length) }, (_, i) => all[i * step]).filter(Boolean);

const hist = {};
for (const m of pick) {
  const t0 = Date.now();
  let label;
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 64 }),
      signal: AbortSignal.timeout(75_000),
    });
    const j = await r.json().catch(() => null);
    const ch = j?.choices?.[0] ?? {};
    const txt = (ch?.message?.content ?? '').trim();
    const rsn = (ch?.message?.reasoning ?? '').trim();
    label = r.status === 200 && txt ? '200' : r.status === 200 && rsn ? '200*' : String(r.status);
  } catch { label = 'ERR'; }
  hist[label] = (hist[label] ?? 0) + 1;
  console.log(`  ${label.padEnd(5)} ${m.padEnd(44)} ${Date.now() - t0}ms`);
  await new Promise((s) => setTimeout(s, GAP));
}
console.log(`\nhistogram: ${JSON.stringify(hist)}  (sample ${pick.length}/${all.length})`);
