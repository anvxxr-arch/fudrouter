// Usage: node --env-file=apps/web/.env scripts/pool-status.mjs [provider-name]
//
// Decrypts a provider's credential blob and reports the account pool: how many
// accounts, which are expired, and which are known-dead. Read-only.
//
// Why this exists: the router persists rotated refresh tokens back into
// provider.credentials_enc, so the only way to see the live pool state is to
// decrypt the blob. Without this, a silently shrinking pool looks healthy.
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';

const PROVIDER = process.argv[2] || process.env.XAI_PROVIDER_NAME || 'xai-grok';
const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;

if (!MASTER) {
	console.error('missing env: CREDENTIALS_MASTER_KEY');
	process.exit(1);
}
if (!DSN) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

function decrypt(wire) {
	const key = Buffer.from(MASTER, 'base64');
	if (key.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	const raw = Buffer.from(wire, 'base64');
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(raw.length - 16);
	const ct = raw.subarray(12, raw.length - 16);
	const d = createDecipheriv('aes-256-gcm', key, iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const sql = postgres(DSN);
try {
	const rows = await sql`
		select id, name, status, base_url, credentials_enc, created_at
		from provider where name = ${PROVIDER}`;
	if (!rows.length) {
		console.error(`provider not found: ${PROVIDER}`);
		process.exit(1);
	}
	const p = rows[0];
	const cred = JSON.parse(decrypt(p.credentials_enc));
	const accounts = cred.accounts || [];
	const now = Date.now();

	console.log(`provider : ${p.name}  [status=${p.status}]`);
	console.log(`base_url : ${p.base_url}`);
	console.log(`updated  : ${p.updated_at?.toISOString?.() ?? p.updated_at}`);
	console.log(`headers  : ${JSON.stringify(cred.default_headers || {})}`);
	console.log(`accounts : ${accounts.length}`);

	let expired = 0,
		valid = 0;
	for (const a of accounts) {
		const exp = Date.parse(a.expired);
		const ok = Number.isFinite(exp) && exp > now;
		if (ok) valid++;
		else expired++;
	}
	console.log(`valid    : ${valid}`);
	console.log(`expired  : ${expired}`);
	console.log(`sample   :`);
	for (const a of accounts.slice(0, 5)) {
		const exp = Date.parse(a.expired);
		const flag = Number.isFinite(exp) && exp > now ? 'valid  ' : 'expired';
		console.log(
			`  ${flag} ${String(a.email).padEnd(40)} exp=${a.expired} rt=${String(a.refresh_token).slice(0, 6)}…`
		);
	}
} finally {
	await sql.end();
}
