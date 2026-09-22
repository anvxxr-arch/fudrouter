// Usage: node --env-file=apps/web/.env scripts/dump-tokens.mjs [n] [--pairs]
//
// Decrypts the provider credential blob and prints N live access tokens, one per
// line. With --pairs, prints `email<TAB>token` so callers can map a token back
// to the account it belongs to.
//
// For probing the upstream directly: fudrouter forwards only the response body,
// so upstream headers and quota endpoints are invisible through it.
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';

const args = process.argv.slice(2);
const pairs = args.includes('--pairs');
const N = Number(args.find((a) => /^\d+$/.test(a)) || 1);
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);
try {
	const [row] = await sql`select credentials_enc from provider where name = 'xai-grok'`;
	const raw = Buffer.from(row.credentials_enc, 'base64');
	const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	const blob = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString());
	for (const a of blob.accounts.slice(0, N)) {
		console.log(pairs ? `${a.email}	${a.access_token}` : a.access_token);
	}
} finally {
	await sql.end();
}
