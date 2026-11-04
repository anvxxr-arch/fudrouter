// Pins the `provider_health_check` reachability rule: an outcome that never
// reached an HTTP verdict must NOT be written as `unhealthy`.
//
// Why this file exists — measured 2026-11-02 on freemodel.in. The upstream sits
// behind an nginx rate gate that answers 502 to a slice of probes (7 of 40
// `/models` reads answered 502 while the pool held 178/183 healthy credentials
// and was serving real traffic). The handler wrote that single 502 as
// `connection.health_status='unhealthy'`, and the catalogue's gate
// (`c.health_status is distinct from 'unhealthy'`, internal/store/catalog.go)
// then dropped EVERY model the connection serves: 163 -> 122 models on
// `https://fudrouter.my.id/v1/models`, twice in eleven minutes (19:06 and
// 19:17 UTC).
//
// The rule under test is the same one `credential_validation` already carries:
// a transport failure or an edge 5xx is information about the network, not a
// verdict about the upstream. Over-reporting here is not a mislabel — it
// silently unpublishes a working provider, so it fails CLOSED, toward keeping
// the last known health.
//
// What must still go `unhealthy`: an explicit answer from the upstream that
// proves the connection cannot serve — a 2xx that is not the JSON model listing
// (an HTML marketing page or SPA fallback is not a chat endpoint). That is a
// real verdict and it stays.
//
// Fixture SQL uses `sql.raw` with interpolated strings, not Date params: a Date
// nested inside a `sql` fragment gets an indeterminate parameter type (42P18).
// The postgres client and the handler import are both inside the test body, so
// `workers.ts` transitively importing `db/index.ts` (which throws without
// DATABASE_URL) does not break the "integration skips without DATABASE_URL"
// contract for the whole process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

/**
 * A stub upstream whose `/models` behaviour is scripted per call.
 *
 * `script` is consumed in order and the last entry repeats forever, so a stub
 * can model "flaps once, then answers" (the rate-gate shape) as well as a
 * steady state.
 */
function stubServer(script) {
	return new Promise((resolve) => {
		let call = 0;
		const server = http.createServer((req, res) => {
			if (req.url === '/models') {
				const step = script[Math.min(call, script.length - 1)];
				call += 1;
				if (step === 'gate-502') {
					res.writeHead(502, { 'content-type': 'text/html' });
					res.end('<html>502 Bad Gateway</html>');
				} else if (step === 'html-200') {
					res.writeHead(200, { 'content-type': 'text/html' });
					res.end('<html><body>Welcome to our marketing site</body></html>');
				} else {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

const SKIP = !process.env.DATABASE_URL;
const MARK = 'conn_hc';

/**
 * Seed one enabled connection pointing at `baseUrl` with `healthStatus`, run
 * the handler, and return the stored row. Each case gets a fresh port so the
 * memoised nothing path is not shared.
 */
async function runHealthCheck(testDb, baseUrl, healthStatus) {
	// system_event is keyed by resource_id, and the tear-downs below delete the
	// connection and provider but NOT the events they emitted. A fixed MARK
	// therefore accumulated `provider.degraded` rows across runs, and the
	// `count(*) = 0` assertion in the edge-5xx case passed only against a virgin
	// database: the second run on the same DSN found the first run's event and
	// failed. Clear the slate here so every case starts from zero regardless of
	// what the previous run left behind.
	await testDb.execute(sql.raw(`delete from system_event where resource_id = '${MARK}'`));
	await testDb.execute(sql.raw(`delete from connection where id = '${MARK}'`));
	await testDb.execute(sql.raw(`delete from provider where id = 'prov_hc'`));
	await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('prov_hc', 'hc-test', '${baseUrl}', 'x', 'active', 100, 'commercial', true) on conflict (id) do nothing`));
	await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('${MARK}', 'prov_hc', 'hc', 'hc', '${baseUrl}', 'us', 'bearer', 30000, 100, true, '${healthStatus}')`));
	await JOB_HANDLERS.provider_health_check(testDb, { connectionId: MARK });
	const rows = await testDb.execute(sql.raw(`select health_status from connection where id = '${MARK}'`));
	return rows[0]?.health_status;
}

let JOB_HANDLERS;
test('provider_health_check: an edge 5xx is not a verdict', { skip: SKIP }, async () => {
	({ JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts'));
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	// A gate that 502s every attempt: three retries, still no verdict.
	const server = await stubServer(['gate-502']);
	try {
		const status = await runHealthCheck(testDb, `http://127.0.0.1:${server.address().port}`, 'healthy');
		assert.equal(
			status,
			'healthy',
			'a 502 from an edge gate must keep the last known health, not unpublish the provider'
		);
		const events = await testDb.execute(sql.raw(`select count(*)::int as n from system_event where resource_id = '${MARK}'`));
		assert.equal(events[0].n, 0, 'a flap must not manufacture a transition event');
	} finally {
		await testDb.execute(sql.raw(`delete from system_event where resource_id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from connection where id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_hc'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});

test('provider_health_check: a retry recovers the verdict from a flapping gate', { skip: SKIP }, async () => {
	({ JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts'));
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	// Flaps once (the measured shape), answers on the retry.
	const server = await stubServer(['gate-502', 'json-200']);
	try {
		const status = await runHealthCheck(testDb, `http://127.0.0.1:${server.address().port}`, 'healthy');
		assert.equal(status, 'healthy', 'the retry must find the 200 behind the flap');
	} finally {
		await testDb.execute(sql.raw(`delete from system_event where resource_id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from connection where id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_hc'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});

test('provider_health_check: an HTML 200 is still a real unhealthy verdict', { skip: SKIP }, async () => {
	({ JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts'));
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	// The upstream ANSWERED: base_url serves a marketing page, not a model
	// listing, so no chat call can work. This must NOT be softened to a keep —
	// keeping the last health is for absent evidence, not for evidence of a
	// broken endpoint.
	const server = await stubServer(['html-200']);
	try {
		const status = await runHealthCheck(testDb, `http://127.0.0.1:${server.address().port}`, 'healthy');
		assert.equal(status, 'unhealthy', 'a 2xx that is not the model listing is a real verdict');
	} finally {
		await testDb.execute(sql.raw(`delete from system_event where resource_id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from connection where id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_hc'`));
		server.close();
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});

test('provider_health_check: an unreachable upstream is not a verdict either', { skip: SKIP }, async () => {
	({ JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts'));
	const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
	process.env.ALLOW_PRIVATE_UPSTREAMS = '1';
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	try {
		// Port 1 on loopback: connection refused, so the probe never reaches an
		// HTTP verdict. Same rule as the edge 5xx — keep the last known health.
		const status = await runHealthCheck(testDb, 'http://127.0.0.1:1', 'healthy');
		assert.equal(status, 'healthy', 'a refused connection must not unpublish the provider');
	} finally {
		await testDb.execute(sql.raw(`delete from system_event where resource_id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from connection where id = '${MARK}'`));
		await testDb.execute(sql.raw(`delete from provider where id = 'prov_hc'`));
		process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
		await testClient.end({ timeout: 5000 });
	}
});
