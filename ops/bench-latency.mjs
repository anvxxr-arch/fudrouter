#!/usr/bin/env node
/**
 * ops/bench-latency.mjs — live latency benchmark for every published model.
 *
 * For each model in /v1/models: N sequential chat probes (tiny prompt,
 * max_tokens small) through the router, records per-request latency,
 * reports p50/p95/max + success rate. Uses a temp API key, revoked on exit.
 *
 * Usage: node ops/bench-latency.mjs [rounds] [concurrency]
 * Env:   BENCH_BASE (default https://fudrouter.my.id)
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE = process.env.BENCH_BASE || 'https://fudrouter.my.id';
const USER_ID = 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const ROUNDS = Number(process.argv[2] || 6);
const CONC = Number(process.argv[3] || 3);

let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const keyId = `key_${randomBytes(8).toString('hex')}`;

execSync(`docker exec postgre psql -U postgres -d fudrouter -c "insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-bench-latency', '${prefix}', '${keyHash}', 'active');"`, { stdio: 'pipe' });
const cleanup = () => {
	try {
		execSync(`docker exec postgre psql -U postgres -d fudrouter -c "update api_key set status='revoked', revoked_at=now() where id='${keyId}';"`, { stdio: 'pipe' });
		console.log(`\n[cleanup] temp key ${keyId} revoked`);
	} catch {}
};
process.on('exit', cleanup);

const auth = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

const list = await fetch(`${BASE}/v1/models`, { headers: auth }).then((r) => r.json());
const models = list.data.map((m) => m.id).sort();
console.log(`[bench] ${models.length} models x ${ROUNDS} rounds, conc ${CONC}\n`);

const pct = (arr, p) => {
	if (arr.length === 0) return 0;
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const ask = async (model) => {
	const t0 = performance.now();
	try {
		const r = await fetch(`${BASE}/v1/chat/completions`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				model,
				max_tokens: 16,
				messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
			}),
			signal: AbortSignal.timeout(60_000),
		});
		const ms = performance.now() - t0;
		let ok = r.status === 200;
		let err = '';
		if (!ok) {
			try { err = (await r.json()).error?.code || String(r.status); } catch { err = String(r.status); }
		}
		return { ms, ok, err };
	} catch (e) {
		return { ms: performance.now() - t0, ok: false, err: e.name === 'TimeoutError' ? 'TIMEOUT' : e.message };
	}
};

const rows = [];
for (const model of models) {
	// warm-up 1 (cold: DNS/TLS/catalog cache), then measured rounds
	await ask(model);
	const jobs = Array.from({ length: ROUNDS }, () => ask(model));
	// bounded concurrency
	const results = [];
	for (let i = 0; i < jobs.length; i += CONC) {
		results.push(...(await Promise.all(jobs.slice(i, i + CONC))));
	}
	const oks = results.filter((r) => r.ok);
	const lats = oks.map((r) => Math.round(r.ms));
	const errs = results.filter((r) => !r.ok).map((r) => r.err);
	rows.push({
		model,
		n: results.length,
		ok: oks.length,
		p50: pct(lats, 50),
		p95: pct(lats, 95),
		max: lats.length ? Math.max(...lats) : 0,
		errs: [...new Set(errs)].join(','),
	});
	const bar = oks.length ? '█'.repeat(Math.min(30, Math.round(pct(lats, 50) / 100))) : '░';
	console.log(
		`${model.padEnd(36)} ok ${String(oks.length).padStart(2)}/${results.length}  p50 ${String(pct(lats, 50)).padStart(6)}ms  p95 ${String(pct(lats, 95)).padStart(6)}ms  max ${String(rows.at(-1).max).padStart(6)}ms  ${bar}${errs.length ? '  ERR: ' + [...new Set(errs)].join(',') : ''}`
	);
}

const live = rows.filter((r) => r.ok > 0);
console.log(`\n[summary] models with >=1 success: ${live.length}/${rows.length}`);
if (live.length) {
	const allP50 = live.map((r) => r.p50).sort((a, b) => a - b);
	console.log(`[summary] p50 across live models: min ${allP50[0]}ms  median ${pct(allP50, 50)}ms  max ${allP50.at(-1)}ms`);
	const slow = live.filter((r) => r.p95 > 5000);
	if (slow.length) console.log(`[summary] SLOW p95>5s: ${slow.map((r) => r.model).join(', ')}`);
	const dead = rows.filter((r) => r.ok === 0).map((r) => `${r.model}(${r.errs})`);
	if (dead.length) console.log(`[summary] DEAD: ${dead.join(', ')}`);
}
