#!/usr/bin/env node
/** Match farm live keys against DB creds (decrypted) to see if the pool holds them. */
import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 2, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
import { readFileSync } from 'node:fs';

const live = readFileSync('/tmp/zro_live_keys.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const farm = readFileSync('/home/dwizzy/farm/zro-farm/data/keys.txt', 'utf8')
	.split('\n').map(l => l.trim()).filter(Boolean)
	.map(l => l.split('|').pop().trim()).filter(k => k.startsWith('sk-'));

const rows = await sql.unsafe(`select c.id, c.secret_enc, c.status from credential c
  join connection cn on c.connection_id = cn.id where cn.provider_id = 'prv_zro'`);
console.log(`db creds: ${rows.length}, farm keys: ${farm.length}, live: ${live.length}`);

const dbKeys = new Map();
for (const r of rows) {
	try {
		const p = decryptCredentials(r.secret_enc);
		dbKeys.set(p.api_key || p.access_token || '', { id: r.id, status: r.status });
	} catch {}
}
console.log(`decrypted: ${dbKeys.size}`);

let inDb = 0;
for (const k of live) {
	const hit = dbKeys.get(k);
	if (hit) { inDb++; console.log(`  LIVE key IS in db -> ${hit.id.slice(0,14)} status=${hit.status}`); }
	else console.log(`  LIVE key NOT in db (prefix ${k.slice(0,6)} len ${k.length})`);
}
console.log(`\nlive keys present in pool: ${inDb}/${live.length}`);

let farmInDb = 0;
for (const k of farm) if (dbKeys.has(k)) farmInDb++;
console.log(`farm keys present in pool: ${farmInDb}/${farm.length}`);
await sql.end({ timeout: 2 });
