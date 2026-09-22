// Usage: node --env-file=apps/web/.env scripts/dump-tokens.mjs [n]
//
// Decrypts the provider credential blob and prints N live access tokens, one per
// line. For probing the upstream directly (fudrouter forwards only the response
// body, so upstream headers like x-ratelimit-* are invisible through it).
import postgres from 'postgres';
import { createDecipheriv } from 'node:crypto';

const N = Number(process.argv[2] || 1);
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);
try {
	const [row] = await sql`select credentials_enc from provider where name = 'xai-grok'`;
	const raw = Buffer.from(row.credentials_enc, 'base64');
	const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	const blob = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString());
	for (const a of blob.accounts.slice(0, N)) console.log(a.access_token);
} finally {
	await sql.end();
}
