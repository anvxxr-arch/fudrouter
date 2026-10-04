#!/usr/bin/env node
// Merge freshly farmed Gonka24 keys into the existing provider pool.
// Usage: node --env-file=apps/web/.env scripts/merge-gonka24-keys.mjs [keys.json]
//
// Re-running an onboard script would REPLACE credentials_enc and silently drop
// the keys already pooled, so this decrypts the blob, appends new keys deduped
// by api_key, and re-encrypts in place. Idempotent — safe to run on a timer.
// Only `working: true` records qualify: an unverified account's $0 balance
// cannot serve traffic, so it must not enter the pool.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEYS_FILE = process.argv[2] || '/home/dwizzy/gonka24-automator/gonka24_keys.json';
// spec §1 (0007_platform_backfill) wraps legacy ids as `prv_<legacy>`, so a bare
// lookup by 'gonka24' matches no row: the merge aborted on every tick while the
// pool silently stopped growing. Resolve the wrapped id, keep the bare id as a
// fallback for a database that has not been backfilled yet.
const LEGACY_PROVIDER_ID = 'gonka24';
const PROVIDER_ID_CANDIDATES = ['prv_' + LEGACY_PROVIDER_ID, LEGACY_PROVIDER_ID];

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function decrypt(b64) {
	const buf = Buffer.from(b64, 'base64');
	const d = createDecipheriv('aes-256-gcm', master, buf.subarray(0, 12));
	d.setAuthTag(buf.subarray(-16));
	return JSON.parse(Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]).toString('utf8'));
}
function encrypt(obj) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', master, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const incoming = JSON.parse(readFileSync(KEYS_FILE, 'utf8')).filter(
	(a) => a && typeof a.api_key === 'string' && a.api_key.startsWith('sk-') && a.working === true
);
console.log(`incoming verified keys: ${incoming.length}`);

try {
	// The farm timer and a manual run can overlap; a read-modify-write on the
	// blob without a row lock lets the slower writer clobber the other's keys.
	// `for update` serialises them (the Go pool's save() merges for the same
	// reason, see references/pool-maintenance.md).
	await sql.begin(async (tx) => {
		const [prov] = await tx`select id from provider where id in ${tx(PROVIDER_ID_CANDIDATES)} limit 1`;
		if (!prov) {
			console.error(
				`provider ${LEGACY_PROVIDER_ID} not found (tried ${PROVIDER_ID_CANDIDATES.join(', ')}) — run onboard-gonka24.mjs first`
			);
			process.exit(1);
		}
		const PROVIDER_ID = prov.id;
		const [row] =
			await tx`select credentials_enc from provider where id = ${PROVIDER_ID} for update`;

		const cred = decrypt(row.credentials_enc);
		const seen = new Set(cred.accounts.map((a) => a.api_key));
		console.log(`existing accounts: ${cred.accounts.length}`);

		let added = 0,
			skipped = 0;
		for (const a of incoming) {
			if (seen.has(a.api_key)) {
				skipped++;
				continue;
			}
			seen.add(a.api_key);
			cred.accounts.push({
				email: a.email || `gonka24-key-${a.api_key.slice(-6)}@gonka24`,
				api_key: a.api_key,
				refresh_token: null,
				access_token: a.api_key,
				expired: '2099-01-01T00:00:00Z'
			});
			added++;
		}
		console.log(`new: ${added} | already pooled: ${skipped}`);

		if (added > 0) {
			const res =
				await tx`update provider set credentials_enc = ${encrypt(cred)} where id = ${PROVIDER_ID}`;
			// An UPDATE matching no rows succeeds: assert the write landed.
			if (res.count !== 1) {
				console.error(`persist matched ${res.count} rows (expected 1)`);
				process.exit(1);
			}
			console.log(`pool now holds ${cred.accounts.length} keys`);
		} else {
			console.log('nothing new — pool unchanged');
		}
		return added;
	});
	console.log('✅ merge done.');
} finally {
	await sql.end();
}
