// Live proof that the router reloads a provider's pool instead of trusting it
// forever. Without the reload the read is the in-memory copy from process start;
// with it, a blob rewritten from outside (an import, the maintenance rotation)
// takes effect within poolReloadAfter.
//
//   node --env-file=apps/web/.env scratch/grok-reload-proof.mjs save
//     → accounts[0] gets a deliberately invalid access_token with a fresh
//       expiry, and its real value is stashed. A rebuilt pool serves the
//       invalid token (upstream 401 → attempt 2); a stale in-memory pool serves
//       the old, still-valid token (attempt 1). The attempt number is the tell.
//   node --env-file=apps/web/.env scratch/grok-reload-proof.mjs restore
//     → puts the real account back.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const SAVED = '/tmp/grok-account0.json';
const MASTER = process.env.CREDENTIALS_MASTER_KEY;
function key() {
	const k = Buffer.from(MASTER, 'base64');
	if (k.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return k;
}
function decrypt(wire) {
	const raw = Buffer.from(wire, 'base64');
	const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}
function encrypt(plain) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [row] = await sql`select id, credentials_enc from provider where name = 'xai-grok'`;
if (!row) {
	console.error('provider xai-grok not found');
	process.exit(1);
}
const cred = JSON.parse(decrypt(row.credentials_enc));
const mode = process.argv[2];

if (mode === 'save') {
	const a0 = cred.accounts[0];
	writeFileSync(SAVED, JSON.stringify(a0), { mode: 0o600 });
	a0.access_token = 'garbage-not-a-token';
	a0.expired = new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
	await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(cred))} where id = ${row.id}`;
	console.log(`accounts[0] = ${a0.email}: access_token replaced with garbage, expiry set 3h out`);
} else if (mode === 'restore') {
	const a0 = JSON.parse(readFileSync(SAVED, 'utf8'));
	cred.accounts[0] = a0;
	await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(cred))} where id = ${row.id}`;
	console.log(`accounts[0] = ${a0.email}: real credential restored`);
} else {
	console.error('usage: grok-reload-proof.mjs save|restore');
	process.exit(2);
}
await sql.end();
