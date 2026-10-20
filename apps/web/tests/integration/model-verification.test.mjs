// Pins the `model_verification` verdict loop end-to-end: probe a stub upstream
// through a real provider/connection/credential fixture and assert the four
// verdicts the job exists to produce.
//
// Why this file exists: the job's entire value is the verdict mapping — a
// provider serving a different model than its catalog claims is the silent
// corruption this table is the only record of. Each verdict branch is a
// different upstream answer to the SAME probe shape, so one stub keyed on the
// requested model covers all of them in a single handler run:
//
//   mv-match  -> 200 echoing the requested slug      => pass
//   mv-lie    -> 200 naming a DIFFERENT model        => mismatch (the bug)
//   mv-gone   -> 404                                 => not_served
//   mv-auth   -> 401                                 => not_served (auth)
//   mv-flaky  -> 500                                 => error (never not_served)
//
// The run is repeated to pin append-only evidence: a second run must APPEND
// five more rows, not UPDATE the first five — the admin surface reads
// max-by-created_at, so an UPDATE would silently erase history.
//
// Same harness rules as credential-validation.test.mjs: the postgres client is
// created INSIDE the test and the handler import is dynamic, because workers.ts
// transitively imports db/index.ts, which throws at import time when
// DATABASE_URL is unset. Skips unless BOTH DATABASE_URL and
// CREDENTIALS_MASTER_KEY are set. ALLOW_PRIVATE_UPSTREAMS is set in the test
// body (the allowPrivateUpstreams() seam in publish-env.ts) so the SSRF guard
// lets the probe reach the 127.0.0.1 stub — without it every probe would record
// a guard error and the verdict mapping would never execute.
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
			if (req.url !== '/chat/completions') {
				res.writeHead(404);
				res.end();
				return;
			}
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				const model = (() => { try { return JSON.parse(body).model; } catch { return null; } })();
				const answer = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
				switch (model) {
					case 'mv-match': return answer(200, { model: 'mv-match', usage: { prompt_tokens: 5, completion_tokens: 2 } });
					case 'mv-lie': return answer(200, { model: 'some-other-model', usage: { prompt_tokens: 7, completion_tokens: 3 } });
					case 'mv-gone': return answer(404, { error: { message: 'model not found' } });
					case 'mv-auth': return answer(401, { error: { message: 'invalid api key' } });
					case 'mv-flaky': return answer(500, { error: { message: 'upstream boom' } });
					default: return answer(400, { error: { message: `unexpected model: ${model}` } });
				}
			});
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

test('model_verification records pass, mismatch, not_served and error verdicts', { skip: !process.env.DATABASE_URL || !process.env.CREDENTIALS_MASTER_KEY }, async () => {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	const server = await stubServer();
	const port = server.address().port;
	try {
		await testDb.execute(sql.raw(`delete from model_verification where provider_model_id in (select id from provider_model where provider_id = 'prov_mv')`));
		await testDb.execute(sql.raw(`delete from provider_model where provider_id = 'prov_mv'`));
		await testDb.execute(sql.raw(`delete from model where provider_id = 'prov_mv'`));
		await testDb.execute(sql.raw(`delete from credential where id = 'cred_mv'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_mv'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_mv'`));
		await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('prov_mv', 'mv-test', 'http://127.0.0.1:${port}', 'x', 'active', 100, 'commercial', true)`));
		await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('conn_mv', 'prov_mv', 'mv-test', 'mv-test', 'http://127.0.0.1:${port}', 'us', 'bearer', 30000, 100, true, 'healthy')`));
		await testDb.execute(sql.raw(`insert into credential (id, connection_id, name, secret_enc, status) values ('cred_mv', 'conn_mv', 'mv-key', '${encryptCredentials({ api_key: 'mv-key' })}', 'unknown')`));
		// One model row per mapping: the COALESCE target index makes
		// (model_id, provider_id, connection) unique, and NULL connection
		// would collide across rows sharing a model.
		for (const slug of ['mv-match', 'mv-lie', 'mv-gone', 'mv-auth', 'mv-flaky']) {
			await testDb.execute(sql.raw(`insert into model (id, provider_id, name, slug, input_price, output_price) values ('m_mv_${slug.replace(/-/g, '_')}', 'prov_mv', '${slug}', '${slug}', 1, 2)`));
			await testDb.execute(sql.raw(`insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled) values ('pm_mv_${slug.replace(/-/g, '_')}', 'm_mv_${slug.replace(/-/g, '_')}', 'prov_mv', 'conn_mv', '${slug}', true)`));
		}

		await JOB_HANDLERS.model_verification(testDb, { providerId: 'prov_mv' });

		const rows = await testDb.execute(sql.raw(`select mv.provider_model_id, mv.requested_slug, mv.response_model, mv.verdict, mv.error, mv.tokens_in, mv.tokens_out, mv.latency_ms from model_verification mv join provider_model pm on pm.id = mv.provider_model_id where pm.provider_id = 'prov_mv'`));
		const bySlug = Object.fromEntries(rows.map((r) => [r.requested_slug, r]));
		assert.equal(rows.length, 5, `one row per enabled mapping, got ${rows.length}`);
		assert.equal(bySlug['mv-match'].verdict, 'pass');
		assert.equal(bySlug['mv-match'].response_model, 'mv-match');
		assert.equal(bySlug['mv-match'].tokens_in, 5);
		assert.equal(bySlug['mv-match'].tokens_out, 2);
		assert.ok(Number(bySlug['mv-match'].latency_ms) >= 0, 'latency is recorded');
		assert.equal(bySlug['mv-lie'].verdict, 'mismatch');
		assert.equal(bySlug['mv-lie'].response_model, 'some-other-model', 'the lying model name is the evidence');
		assert.equal(bySlug['mv-gone'].verdict, 'not_served');
		assert.match(bySlug['mv-gone'].error, /HTTP 404/);
		assert.equal(bySlug['mv-auth'].verdict, 'not_served');
		assert.match(bySlug['mv-auth'].error, /HTTP 401/);
		assert.equal(bySlug['mv-flaky'].verdict, 'error', 'a 5xx proves nothing about what is served and must never become not_served');
		assert.match(bySlug['mv-flaky'].error, /HTTP 500/);
		assert.ok(rows.every((r) => r.provider_model_id), 'every verdict is bound to its mapping');

		// Second run: evidence is APPENDED, not updated — five more rows, and
		// the verdicts still hold. An UPDATE-based implementation would leave
		// the count at 5 and erase the first run's history.
		await JOB_HANDLERS.model_verification(testDb, { providerId: 'prov_mv' });
		const total = await testDb.execute(sql.raw(`select count(*)::int as n from model_verification mv join provider_model pm on pm.id = mv.provider_model_id where pm.provider_id = 'prov_mv'`));
		assert.equal(total[0].n, 10, 'a second run appends a second verdict per mapping');
	} finally {
		await testDb.execute(sql.raw(`delete from model_verification where provider_model_id in (select id from provider_model where provider_id = 'prov_mv')`));
		await testDb.execute(sql.raw(`delete from provider_model where provider_id = 'prov_mv'`));
		await testDb.execute(sql.raw(`delete from model where provider_id = 'prov_mv'`));
		await testDb.execute(sql.raw(`delete from credential where id = 'cred_mv'`));
		await testDb.execute(sql.raw(`delete from connection where id = 'conn_mv'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_mv'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});
