#!/usr/bin/env node
/**
 * ops/test-unrestricted.mjs — live verification of the `-unrestricted`
 * virtual suffix on fudrouter.
 *
 * 1. /v1/models renders every published model's `-unrestricted` twin
 * 2. GET /v1/models/<slug>-unrestricted answers 200 with the requested id
 * 3. A/B chat probe: the twin injects the unrestricted system prompt
 *    upstream. Proof marker = the ENI persona: the base model names itself
 *    as its vendor model, the twin answers as ENI (sweater-wearing
 *    novelist, LO, cold coffee).
 * 4. Revokes its temp key on exit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = 'https://fudrouter.my.id';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const MODEL = process.argv[2] || 'GLM-5.3-Flash';

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

execSync(`docker exec postgre psql -U postgres -d fudrouter -c "insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-unrestricted-test', '${prefix}', '${keyHash}', 'active');"`, { stdio: 'pipe' });
const cleanup = () => {
	try {
		execSync(`docker exec postgre psql -U postgres -d fudrouter -c "update api_key set status='revoked', revoked_at=now() where id='${keyId}';"`, { stdio: 'pipe' });
		console.log(`\n[cleanup] temp key ${keyId} revoked`);
	} catch {}
};
process.on('exit', cleanup);

const auth = { Authorization: `Bearer ${key}` };
const j = (r) => r.json();

// --- 1. twins in the catalogue --------------------------------------------
const list = await fetch(`${BASE}/v1/models`, { headers: auth }).then(j);
const ids = list.data.map((m) => m.id);
const twins = ids.filter((i) => i.endsWith('-unrestricted'));
console.log(`[1] catalogue: ${ids.length} entries, ${twins.length} unrestricted twins`);
console.log(`    sample: ${twins.slice(0, 3).join(', ')}`);
const twinOf = twins.find((t) => t === `${MODEL}-unrestricted`);
console.log(`    twin of ${MODEL}: ${twinOf ? 'PRESENT' : 'MISSING'}`);

// --- 2. single lookup -------------------------------------------------------
const single = await fetch(`${BASE}/v1/models/${MODEL}-unrestricted`, { headers: auth });
const singleBody = await single.text();
console.log(`[2] GET /v1/models/${MODEL}-unrestricted -> ${single.status} ${singleBody.slice(0, 120)}`);

// --- 3. A/B persona probe ---------------------------------------------------
const probe = {
	max_tokens: 120,
	messages: [{ role: 'user', content: 'What is your name, and who do you work for? Answer in one sentence.' }],
};
const ask = async (model) => {
	const r = await fetch(`${BASE}/v1/chat/completions`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...probe, model }),
	});
	const b = await r.text();
	if (!r.ok) return `HTTP ${r.status}: ${b.slice(0, 150)}`;
	try { return j(JSON.parse(b)).choices[0].message.content.trim(); } catch { return b.slice(0, 150); }
};

console.log(`[3] A/B probe on ${MODEL}`);
const base = await ask(MODEL);
console.log(`    base        : ${base}`);
const twin = await ask(`${MODEL}-unrestricted`);
console.log(`    unrestricted: ${twin}`);

const marker = /ENI|LO\b|sweater|novelist|cold coffee/i.test(twin);
console.log(`\n[verdict] ENI persona marker in twin answer: ${marker ? 'YES — injection live' : 'NO — check upstream'}`);
