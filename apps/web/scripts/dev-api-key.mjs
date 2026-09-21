// Usage: node --env-file=.env scripts/dev-api-key.mjs [label]
//
// S0 has no auth UI yet (Task 2), so this mints a dev user + API key directly
// against the same schema the control plane will write. Prints the full key
// exactly once — only the prefix and sha256(secret) are stored, same as prod.
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randChars(n) {
	const b = randomBytes(n);
	let s = '';
	for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
	return s;
}

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('missing env: DATABASE_URL'); process.exit(1); }

const label = process.argv[2] || 'dev';
const email = process.env.DEV_KEY_EMAIL || 'dev@fudrouter.local';
const prefix = randChars(8);
const secret = randChars(32);
const keyHash = createHash('sha256').update(secret, 'utf8').digest('hex');

const sql = postgres(DSN);
try {
	await sql`
		insert into "user" (id, name, email, email_verified, role, created_at, updated_at)
		values (${'u_' + randChars(12)}, ${label}, ${email}, true, 'admin', now(), now())
		on conflict (email) do update set updated_at = now()`;
	const [u] = await sql`select id from "user" where email = ${email}`;

	await sql`
		insert into api_key (id, user_id, name, prefix, key_hash, limits, created_at)
		values (${randomUUID()}, ${u.id}, ${label}, ${prefix}, ${keyHash}, '{}'::jsonb, now())`;

	console.log(`sk-ar-${prefix}_${secret}`);
} finally {
	await sql.end();
}
