#!/usr/bin/env node
// Verify the per-account 404 failover through the live router.
//
// The bug this proves fixed: tokenharbor gates models PER ACCOUNT. Two of the
// pool's accounts answer mimo-v2.6-flash:free with a 404 while the rest serve
// it fine, so the round-robin used to kill the request on a bad pick. The
// request is retried N times to make a bad-account landing likely.
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const BASE = process.env.ROUTER_BASE || 'http://127.0.0.1:8100';
const MODELS = ['deepseek-v4.1-flash', 'mimo-v2.6-flash'];
const ROUNDS = 2;

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

process.on('exit', () => {
  execSync(`docker exec postgre psql -U postgres -d fudrouter -c "update api_key set status='revoked', revoked_at=now() where id='${keyId}';"`, { stdio: 'pipe' });
});

execSync(`docker exec postgre psql -U postgres -d fudrouter -c "insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-404-failover-test', '${prefix}', '${keyHash}', 'active');"`, { stdio: 'pipe' });

async function ask(model) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'say ok' }],
      max_tokens: 8,
    }),
  });
  const text = await res.text();
  let note = '';
  try { note = JSON.parse(text).choices?.[0]?.message?.content?.slice(0, 20) || JSON.parse(text).error?.message?.slice(0, 60) || ''; } catch { note = text.slice(0, 60); }
  return `${res.status} ${note}`.trim();
}

for (const model of MODELS) {
  const results = [];
  for (let i = 0; i < ROUNDS; i++) results.push(await ask(model));
  const ok = results.filter(r => r.startsWith('200')).length;
  console.log(`${model}: ${ok}/${ROUNDS} x 200`);
  if (ok < ROUNDS) for (const [i, r] of results.entries()) if (!r.startsWith('200')) console.log(`  round ${i + 1}: ${r}`);
}
