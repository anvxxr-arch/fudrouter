// Pins the `credential_validation` verdict loop end-to-end: decrypt a real
// envelope, probe a stub upstream, write the verdict + cursor + cooldown.
//
// Why this file exists: the cursor fix (`lastValidatedAt` ordering) was
// verified on the decrypt-ERROR path only, and the success path was once
// "proven" by a fixture that returned `unknown` for both rows — the SSRF guard
// had refused the 127.0.0.1 stub because ALLOW_PRIVATE_UPSTREAMS was unset, so
// the probe never happened and `unknown` was recorded as a pass. This test sets
// that knob in its own test body (the `allowPrivateUpstreams()` seam in
// publish-env.ts:35) so the probe actually reaches the stub, and asserts the
// two verdicts that matter: `healthy` (no cooldown) for a valid key,
// `auth_failed` (+55min cooldown) for a wrong one, with `lastValidatedAt`
// advancing on both.
//
// Fixture SQL uses `sql.raw` with interpolated strings, not Date params: a Date
// nested inside a `sql` fragment gets an indeterminate parameter type (42P18) —
// the same quirk retentionBatch documents at workers.ts:804-808.
//
// The postgres client is created INSIDE the test, not at module scope, and the
// handler import is dynamic for the same reason: `workers.ts` transitively
// imports `db/index.ts`, which throws at import time when DATABASE_URL is
// unset — that would break the "integration skips without DATABASE_URL"
// contract for the whole process. The test skips unless BOTH DATABASE_URL and
// CREDENTIALS_MASTER_KEY are set (`encryptCredentials` throws without the key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { encryptCredentials } from '@fudrouter/platform/server/credentials.ts';

function stubServer() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			if (req.url === '/models') {
				if ((req.headers.authorization || '') === 'Bearer valid-key-123') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
				} else {
					res.writeHead(401, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'invalid key' }));
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

test('credential_validation writes healthy and auth_failed verdicts', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	const server = await stubServer();
	const port = server.address().port;
	try {
		await testDb.execute(sql.raw(`delete from credential where id like 'cred_vt%'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_vt'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_vt'`));
		await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('prov_vt', 'test', 'http://127.0.0.1:${port}', 'x', 'active', 100, 'commercial', true) on conflict (id) do nothing`));
		await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('conn_vt', 'prov_vt', 'test', 'test', 'http://127.0.0.1:${port}', 'us', 'bearer', 30000, 100, true, 'healthy') on conflict (id) do nothing`));
		const validEnc = encryptCredentials({ api_key: 'valid-key-123' });
		const invalidEnc = encryptCredentials({ api_key: 'wrong-key' });
		await testDb.execute(sql.raw(`insert into credential (id, connection_id, name, secret_enc, status, last_validated_at) values ('cred_vt_valid', 'conn_vt', 'valid', '${validEnc}', 'unknown', null), ('cred_vt_invalid', 'conn_vt', 'invalid', '${invalidEnc}', 'unknown', null)`));

		await JOB_HANDLERS.credential_validation(testDb, { credentialId: 'cred_vt_valid' });
		await JOB_HANDLERS.credential_validation(testDb, { credentialId: 'cred_vt_invalid' });

		const rows = await testDb.execute(sql.raw(`select id, status, last_validated_at, cooldown_until from credential where id like 'cred_vt%' order by id`));
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		assert.equal(byId.cred_vt_valid.status, 'healthy');
		assert.ok(byId.cred_vt_valid.last_validated_at, 'valid row must advance the cursor');
		assert.equal(byId.cred_vt_valid.cooldown_until, null);
		assert.equal(byId.cred_vt_invalid.status, 'auth_failed');
		assert.ok(byId.cred_vt_invalid.last_validated_at, 'invalid row must advance the cursor');
		assert.ok(byId.cred_vt_invalid.cooldown_until, 'auth_failed must park the credential');
	} finally {
		await testDb.execute(sql.raw(`delete from credential where id like 'cred_vt%'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_vt'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_vt'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});
