#!/usr/bin/env node
// ops/probe-openrouter-live.mjs — decrypt openrouter keys and test them for REAL:
//   GET /api/v1/key  (authenticated -> is_free_tier + limit_remaining)
//   POST /v1/chat/completions with a :free slug
// Never prints the key.
import { db } from '@fudrouter/platform/server/db/index.ts';
import { credential, connection } from '@fudrouter/platform/server/db/schema.ts';
import { decryptCredentials } from '@fudrouter/platform/server/credentials.ts';
import { eq } from 'drizzle-orm';

const rows = await db
  .select({ credId: credential.id, secretEnc: credential.secretEnc, status: credential.status })
  .from(credential)
  .innerJoin(connection, eq(connection.id, credential.connectionId))
  .where(eq(connection.providerId, 'prv_openrouter'))
  .orderBy(credential.id);

const getKey = (secretEnc) => {
  const dec = decryptCredentials(secretEnc);
  const k = dec?.api_key || dec?.accounts?.[0]?.api_key || dec?.accounts?.[0]?.access_token || null;
  return k;
};

console.log(`openrouter creds: ${rows.length}\n`);

let alive = 0;
for (const r of rows) {
  const key = getKey(r.secretEnc);
  if (!key) { console.log(`${r.credId.slice(-8)}  NO_KEY (status=${r.status})`); continue; }
  const re = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
  const body = await re.json().catch(() => ({}));
  const d = body?.data ?? body;
  const isFree = d?.is_free_tier;
  const limit = d?.limit ?? '?';
  const remaining = d?.limit_remaining ?? '?';
  const tag = re.ok ? `${d?.usage ? 'USED:'+d.usage : ''} limit=${limit} remaining=${remaining} free_tier=${isFree}` : `HTTP ${re.status} ${JSON.stringify(body).slice(0,80)}`;
  if (re.ok) alive++;
  console.log(`${r.credId.slice(-8)}  ${re.status}  ${tag}`);
}

const FREE_MODELS = [
  'deepseek/deepseek-chat-v3-0324:free',
  'deepseek/deepseek-r1:free',
  'nvidia/llama-3.3-nemotron-super-49b-v1:free',
  'mistralai/ministral-8b:free',
  'meta-llama/llama-4-maverick:free',
];

console.log(`\nalive keys: ${alive}/${rows.length}\n--- :free chat test (first live key) ---`);
const liveKey = rows.map(r => getKey(r.secretEnc)).find(Boolean);
if (liveKey) {
  for (const m of FREE_MODELS.slice(0, 3)) {
    const t0 = Date.now();
    const re = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${liveKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    const b = await re.json().catch(() => ({}));
    const dt = Date.now() - t0;
    console.log(`${m}  HTTP ${re.status}  ${dt}ms  ${b?.error?.message || (b?.choices?.[0]?.message?.content ? 'OK:' + JSON.stringify(b.choices[0].message.content) : '')}`);
  }
} else {
  console.log('NO live key to test');
}