// Positive control for refresh-grok-pool.mjs's health exit code: a run that
// drops accounts must exit 1, not print a cheerful summary and exit 0.
//
//   create → provider `xai-grok-health-test` with 2 accounts whose refresh is
//            terminally refused (garbage tokens, expiry inside the window) and
//            1 account outside the window, which must survive.
//   delete → removes the fixture provider.
//
// The run against it must print UNHEALTHY and exit 1 (2 dropped, 1 kept).
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NAME = 'xai-grok-health-test';
const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const key = () => {
	const k = Buffer.from(MASTER, 'base64');
	if (k.length !== 32) throw new Error('key must be base64 of 32 bytes');
	return k;
};
const encrypt = (plain) => {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};
const future = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
if (process.argv[2] === 'create') {
	const blob = {
		auth_kind: 'oauth',
		accounts: [
			{ email: 'dead-1@health.dev', access_token: 'x', refresh_token: 'garbage-one', expired: future(60_000) },
			{ email: 'dead-2@health.dev', access_token: 'x', refresh_token: 'garbage-two', expired: future(60_000) },
			{ email: 'survivor@health.dev', access_token: 'x', refresh_token: 'not-a-target', expired: future(5 * 3600_000) }
		],
		default_headers: {}
	};
	await sql`insert into provider (id, name, base_url, credentials_enc, status, priority)
		values ('health-test-provider', ${NAME}, 'https://cli-chat-proxy.grok.com/v1', ${encrypt(JSON.stringify(blob))}, 'dev', 100)
		on conflict (id) do update set credentials_enc = excluded.credentials_enc, name = excluded.name`;
	console.log(`created ${NAME}: 2 terminally-dead accounts in the window, 1 survivor outside it`);
} else if (process.argv[2] === 'delete') {
	await sql`delete from provider where id = 'health-test-provider'`;
	console.log(`deleted ${NAME}`);
} else {
	console.error('usage: grok-health-control.mjs create|delete');
	process.exit(2);
}
await sql.end();
