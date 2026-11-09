#!/usr/bin/env node
// ops/probe-credentials.mjs — live-probe stored credentials against a
// provider's upstream, decrypting the secret envelopes like the router does.
// Answers the one question that decides whether an `invalid`/`disabled` bulk
// state was a real kill or an accident: do any stored keys still answer a
// completion?
//
// Usage: set -a && . .env && set +a && \
//   node ops/probe-credentials.mjs --provider prv_zro [--models m1,m2] [--n 4]
import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');

const provArg = process.argv.indexOf('--provider');
const PROV = provArg >= 0 ? process.argv[provArg + 1] : '';
if (!PROV) { console.error('usage: probe-credentials.mjs --provider prv_x [--models ...] [--n N]'); process.exit(2); }
const modelsArg = process.argv.indexOf('--models');
const MODELS = (modelsArg >= 0 ? process.argv[modelsArg + 1] : 'deepseek-v4-flash-0731,deepseek-v4.1-flash,glm-5.3-flash').split(',');
const nArg = process.argv.indexOf('--n');
const N = nArg >= 0 ? Number(process.argv[nArg + 1]) : 4;

const prov = await sql`select id, base_url from provider where id = ${PROV}`;
if (!prov.length) { console.error(`no provider ${PROV}`); process.exit(2); }
const base = (prov[0].base_url || '').replace(/\/+$/, '');
const rows = await sql`
	select cr.id, cr.secret_enc, cr.status, cn.base_url as conn_url
	from credential cr
	join connection cn on cn.id = cr.connection_id
	where cn.provider_id = ${PROV}
	order by cr.updated_at desc limit ${N}`;
console.log(`${PROV}: ${rows.length} stored creds to probe (${MODELS.join(', ')}) via ${base}`);

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
			const res = await fetch(`${base || r.conn_url}/chat/completions`, {
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
