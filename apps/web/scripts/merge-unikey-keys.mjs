#!/usr/bin/env node
// Merge a batch of UniKey API keys into the existing `unikey` provider pool.
// Decrypts credentials_enc, appends new keys (deduped by api_key), re-encrypts.
// Usage: node --env-file=apps/web/.env apps/web/scripts/merge-unikey-keys.mjs <keys-file>
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEYS_FILE = process.argv[2];
if (!KEYS_FILE) {
	console.error('usage: merge-unikey-keys.mjs <keys-file>');
	process.exit(1);
}
const PROVIDER_ID = 'unikey';

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');

function encrypt(obj) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', master, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function decrypt(enc) {
	const buf = Buffer.from(enc, 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(buf.length - 16);
	const ct = buf.subarray(12, buf.length - 16);
	const d = createDecipheriv('aes-256-gcm', master, iv);
	d.setAuthTag(tag);
	return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL);
try {
	const [row] = await sql`select credentials_enc from provider where id = ${PROVIDER_ID}`;
	if (!row) throw new Error(`provider ${PROVIDER_ID} not found`);

	const cred = decrypt(row.credentials_enc);
	const accounts = Array.isArray(cred.accounts) ? cred.accounts : [];
	const before = accounts.length;
	const have = new Set(accounts.map((a) => a.api_key));

	const incoming = readFileSync(KEYS_FILE, 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('sk-'));
	console.log(`file keys: ${incoming.length}, pool before: ${before}`);

	let added = 0;
	for (const k of incoming) {
		if (have.has(k)) continue;
		have.add(k);
		accounts.push({
			email: `unikey-key-${accounts.length + 1}@getunikey.ai`,
			api_key: k,
			refresh_token: null,
			access_token: k,
			expired: '2099-01-01T00:00:00Z'
		});
		added++;
	}
	cred.accounts = accounts;

	const res =
		await sql`update provider set credentials_enc = ${encrypt(cred)} where id = ${PROVIDER_ID}`;
	// An UPDATE matching no rows succeeds: assert the write landed instead of
	// trusting the exit code (see references/pool-maintenance.md).
	if (res.count !== 1) {
		console.error(`persist matched ${res.count} provider rows (expected 1)`);
		process.exit(1);
	}
	console.log(`added ${added} new keys -> pool now ${accounts.length}`);
} finally {
	await sql.end();
}
