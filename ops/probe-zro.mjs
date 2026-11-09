#!/usr/bin/env node
// ops/probe-zro.mjs — live-probe the zro farm credentials against
// zro.moonmath.ai, decrypting the stored secret envelopes like the router does.
// The DB pool is ALL invalid right now (452 rows); this script answers the one
// question that decides whether that was a real kill or a bulk-state accident:
// do any of the stored keys still answer a completion?
//
// Usage: set -a && . .env && set +a && node ops/probe-zro.mjs [--models m1,m2]
import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');

const modelsArg = process.argv.indexOf('--models');
const MODELS = (modelsArg >= 0 ? process.argv[modelsArg + 1] : 'deepseek-v4-flash-0731,deepseek-v4.1-flash,glm-5.3-flash').split(',');

const rows = await sql.unsafe(`select id, secret_enc, status from credential
  where connection_id = 'con_prv_zro-default'
  order by updated_at desc limit 4`);
console.log(`zro: ${rows.length} stored creds to probe (${MODELS.join(', ')})`);

for (const r of rows) {
	let key = '';
	try {
		const p = decryptCredentials(r.secret_enc);
		key = p.api_key || p.access_token || '';
	} catch (e) {
		console.log(`  ${r.id.slice(0, 14)} [${r.status}] DECRYPT-FAIL: ${String(e.message).slice(0, 40)}`);
		continue;
	}
	if (!key) { console.log(`  ${r.id.slice(0, 14)} [${r.status}] no api key in envelope`); continue; }
	for (const model of MODELS) {
		try {
			const t0 = Date.now();
			const res = await fetch('https://zro.moonmath.ai/v1/chat/completions', {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8 }),
				signal: AbortSignal.timeout(30000),
			});
			const b = await res.text().catch(() => '');
			const ms = Date.now() - t0;
			let toks = '';
			try { toks = JSON.parse(b).usage?.total_tokens + ' tok'; } catch {}
			console.log(`  ${r.id.slice(0, 14)} [${r.status}] ${model.padEnd(28)} -> ${res.status} ${ms}ms ${toks} ${b.slice(0, 70).replace(/\s+/g, ' ')}`);
		} catch (e) {
			console.log(`  ${r.id.slice(0, 14)} [${r.status}] ${model.padEnd(28)} -> ERR ${String(e.message).slice(0, 45)}`);
		}
	}
}
await sql.end({ timeout: 1 });
