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
// `invalid` for a wrong one — the router's usable predicate excludes `invalid`
// outright, so no cooldown is needed to withhold it (the old `auth_failed`
// verdict was NOT an exclusion, which is why it needed a 55min park) — with
// `lastValidatedAt` advancing on both.
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

function stubServer(mode = 'default') {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			if (req.url === '/models') {
				const auth = req.headers.authorization || '';
				if (auth === 'Bearer valid-key-123') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
				} else if (auth === 'Bearer gate-502-key') {
					// An edge rate gate answering 5xx. The probe reached no auth
					// check, so it learned nothing about the key.
					res.writeHead(502, { 'content-type': 'text/html' });
					res.end('<html>502 Bad Gateway</html>');
				} else if (auth === '') {
					// freemodel.in's shape: the listing is served to anyone, but a
					// supplied (wrong) key is still rejected. An anonymous 200 here
					// is NOT proof the endpoint ignores credentials.
					if (mode === 'gate-eats-bogus') {
						// The SAME rate gate that throttles real calls also throttles
						// the invalid-key probe, so "can't tell" is the only honest
						// reading — it must not be mistaken for "public".
						res.writeHead(502, { 'content-type': 'text/html' });
						res.end('<html>502 Bad Gateway</html>');
					} else {
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
					}
				} else if (mode === 'truly-public') {
					// openrouter/kiraai shape: every request gets 200, so the
					// authenticated 200 proves nothing.
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

test('credential_validation writes healthy and invalid verdicts', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
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
		assert.equal(byId.cred_vt_invalid.status, 'invalid');
		assert.ok(byId.cred_vt_invalid.last_validated_at, 'invalid row must advance the cursor');
		// `invalid` is a hard exclusion in the router's usable predicate
		// (`status not in ('disabled','invalid')`), so the row is withheld
		// without a cooldown — the cooldown exists for `rate_limited` only.
		assert.equal(byId.cred_vt_invalid.cooldown_until, null, 'an excluded status needs no cooldown');
		const usableRows = await testDb.execute(sql.raw(`select (status not in ('disabled','invalid'))::int as u from credential where id = 'cred_vt_invalid'`));
		assert.equal(usableRows[0].u, 0, 'the router predicate must skip a revoked credential');
	} finally {
		await testDb.execute(sql.raw(`delete from credential where id like 'cred_vt%'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_vt'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_vt'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});

// A 5xx from the probe path must not demote a credential the data plane has
// already proven works. poolrebuild refreshes the legacy provider blob from
// `status = 'healthy'` rows only, so demoting to 'unknown' does not just look
// wrong in the console — it removes the row from the on-demand pool until the
// next passing probe. freemodel.in's nginx gate answers 502 to a burst of
// probes, which demoted 19 fresh rows in three minutes on 2026-11-02.
test('credential_validation keeps an earned healthy verdict through a 5xx probe', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	const server = await stubServer();
	const port = server.address().port;
	try {
		await testDb.execute(sql.raw(`delete from credential where id like 'cred_vg%'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_vg'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_vg'`));
		await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('prov_vg', 'test', 'http://127.0.0.1:${port}', 'x', 'active', 100, 'commercial', true) on conflict (id) do nothing`));
		await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('conn_vg', 'prov_vg', 'test', 'test', 'http://127.0.0.1:${port}', 'us', 'bearer', 30000, 100, true, 'healthy') on conflict (id) do nothing`));
		const gateEnc = encryptCredentials({ api_key: 'gate-502-key' });
		await testDb.execute(sql.raw(`insert into credential (id, connection_id, name, secret_enc, status, last_validated_at) values ('cred_vg_gate', 'conn_vg', 'gate', '${gateEnc}', 'healthy', null)`));

		await JOB_HANDLERS.credential_validation(testDb, { credentialId: 'cred_vg_gate' });

		const rows = await testDb.execute(sql.raw(`select status, last_validated_at, cooldown_until from credential where id = 'cred_vg_gate'`));
		assert.equal(rows[0].status, 'healthy', 'a 5xx probe must not demote an earned healthy verdict');
		assert.equal(rows[0].cooldown_until, null, 'an indeterminate probe must not park the row');
		assert.ok(rows[0].last_validated_at, 'the cursor must still advance, or the batch re-probes this row forever');
	} finally {
		await testDb.execute(sql.raw(`delete from credential where id like 'cred_vg%'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_vg'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_vg'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});

// Runs one credential through the handler against a given stub shape and
// returns the resulting row. Keeps the two "is this 200 evidence?" cases from
// repeating 15 lines of fixture SQL each.
async function probeAgainst(mode, key, credId, connId, provId) {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	const server = await stubServer(mode);
	const port = server.address().port;
	try {
		await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('${provId}', 'test', 'http://127.0.0.1:${port}', 'x', 'active', 100, 'commercial', true) on conflict (id) do nothing`));
		await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('${connId}', '${provId}', 'test', 'test', 'http://127.0.0.1:${port}', 'us', 'bearer', 30000, 100, true, 'healthy') on conflict (id) do nothing`));
		await testDb.execute(sql.raw(`insert into credential (id, connection_id, name, secret_enc, status, last_validated_at) values ('${credId}', '${connId}', 'probe', '${encryptCredentials({ api_key: key })}', 'healthy', null)`));
		await JOB_HANDLERS.credential_validation(testDb, { credentialId: credId });
		const rows = await testDb.execute(sql.raw(`select status from credential where id = '${credId}'`));
		return rows[0]?.status;
	} finally {
		await testDb.execute(sql.raw(`delete from credential where id = '${credId}'`));
		await testDb.execute(sql.raw(`delete from connection where id = '${connId}'`));
		await testDb.execute(sql.raw(`delete from provider where id = '${provId}'`));
		server.close();
		await testClient.end({ timeout: 5000 });
	}
}

// The gate that throttles real calls also throttles the invalid-key probe, so
// the check gets a 502 rather than a 401. "Can't tell" must not be read as
// "public" — that inversion is what demoted the whole freemodel pool.
test('a throttled invalid-key probe does not make a keyed 200 meaningless', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	try {
		assert.equal(
			await probeAgainst('gate-eats-bogus', 'valid-key-123', 'cred_vb_gate', 'conn_vb', 'prov_vb'),
			'healthy'
		);
	} finally {
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
	}
});

// The shape the check was written for: /models answers 200 to everyone, so an
// authenticated 200 carries no information and must stay 'unknown'.
test('a genuinely public /models still yields unknown', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	try {
		assert.equal(
			await probeAgainst('truly-public', 'valid-key-123', 'cred_vp_pub', 'conn_vp', 'prov_vp'),
			'unknown'
		);
	} finally {
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
	}
});
