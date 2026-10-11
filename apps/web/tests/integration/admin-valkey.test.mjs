// tests/integration/admin-valkey.test.mjs — the ValKey-backed admin panels.
//
// The baseline (docs/migration/2026-10-10-phase0-baseline.md §5) records the
// management API as uncovered, and these three routes are every place the console
// reads Valkey: the valkey panel (INFO/DBSIZE/PING + a namespace SCAN), the
// throttling view (concurrency gauges) and the circuit-breaker list (per-target
// state). They used to hand-roll RESP over a raw socket; they now go through the
// platform's shared ioredis client (packages/platform/server/vk.ts), so what is
// worth pinning over HTTP is that an admin request still reads a live instance --
// and that the FIRST command in a cold process does not report a healthy instance
// as down. That was a real failure mode, measured rather than feared: AUTH and
// PING answered +OK/+PONG by hand while the same client's first ping() rejected
// with "Stream isn't writeable and enableOfflineQueue options is false" (the
// client is lazy and refuses to queue; see _vkReady in server/lib/format.mjs).
// The first admin request below is always cold, so this file is that net.
//
// Gating: module-scope, like auth-session.test.mjs — a skip inside test.before
// does not work in Node 22. The live assertions additionally skip when the
// spawned server has no VALKEY_URL. The disabled shape is NOT skipped: a second
// server is spawned with VALKEY_URL='' so the branch that renders dashes is
// exercised anywhere a throwaway database exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';
import { _vk, _vkReady } from '../../server/lib/format.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const hasVk = Boolean(process.env.VALKEY_URL);
const VK_SKIP = 'no VALKEY_URL — the spawned server has no instance to read';
// Both gates have to short-circuit into a skip string: passing a boolean would
// let the body run with no server when the database is absent.
const NEEDS_DB = { skip: !hasDb && SKIP };
const NEEDS_VK = { skip: (!hasDb && SKIP) || (!hasVk && VK_SKIP) };

let server;
let sql;
let memberCookie; // a plain user: the gate must refuse this
let adminCookie; // promoted below: the gate must serve this

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	// A plain user first, and asserted before any promotion — a passing 403
	// cannot be a leftover admin role from an earlier run.
	const member = await signUp(server.baseUrl, { email: uniqueEmail('member') });
	assert.equal(member.status, 200, `sign-up failed: ${JSON.stringify(member.body)}`);
	memberCookie = member.cookie;

	const promoted = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(promoted.status, 200, `sign-up failed: ${JSON.stringify(promoted.body)}`);
	adminCookie = promoted.cookie;
	const email = promoted.body?.user?.email;
	assert.ok(email, 'sign-up must return the user email');

	// Promotion is a row update, not a new session: admin.mjs gate -> authedUser
	// -> getSessionUser -> better-auth's getSession, which resolves the user row
	// per request (no cookieCache is configured, checked in index.mjs). The test
	// below asserts that reading instead of trusting it — if better-auth ever
	// caches the role, the 200 becomes a 403 and says so.
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	const rows = await sql`update "user" set role = 'admin' where email = ${email} returning id`;
	assert.equal(rows.length, 1, 'the promoted user must exist in the throwaway database');
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
	// The shared client keeps the process alive (an open socket plus reconnect
	// timers), so a passing suite would otherwise hang instead of exiting.
	_vk()?.disconnect();
});

const get = (base, path, cookie) =>
	fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });

test('a plain user is refused by the admin gate, not shown an empty panel', NEEDS_DB, async () => {
	const anon = await get(server.baseUrl, '/api/admin/system/valkey');
	assert.equal(anon.status, 401, 'no cookie must be 401');
	const member = await get(server.baseUrl, '/api/admin/system/valkey', memberCookie);
	assert.equal(member.status, 403, 'a non-admin session must be 403, not an empty 200');
});

test('the promotion takes effect on the next request (role read from the row)', NEEDS_DB, async () => {
	const res = await get(server.baseUrl, '/api/admin/system/valkey', adminCookie);
	assert.equal(res.status, 200, `admin valkey panel failed: ${await res.text()}`);
});

test('the valkey panel reads a live instance on a cold process', NEEDS_VK, async () => {
	// Cold on purpose: this is the first Valkey command the spawned server runs.
	const res = await get(server.baseUrl, '/api/admin/system/valkey', adminCookie);
	const raw = await res.text();
	assert.equal(res.status, 200, `valkey panel failed: ${raw}`);
	const body = JSON.parse(raw);
	assert.equal(body.configured, true, 'VALKEY_URL is set, so the panel must report an instance');
	assert.equal(typeof body.latencyMs, 'number', 'a live PING must be timed');
	assert.ok(body.latencyMs >= 0 && body.latencyMs < 4000, `latencyMs must be measured; got ${body.latencyMs}`);
	assert.equal(typeof body.dbsize, 'number', 'DBSIZE must parse as a number');
	assert.equal(typeof body.info.usedMemory, 'number', 'INFO used_memory must parse');
	assert.ok(body.info.usedMemory > 0, `a live instance reports memory; got ${body.info.usedMemory}`);
	assert.ok(Array.isArray(body.namespaces) && body.namespaces.length > 0);
	assert.ok(
		body.namespaces.every((n) => typeof n.prefix === 'string' && typeof n.count === 'number'),
		`each namespace row is {prefix,count}; got ${JSON.stringify(body.namespaces)}`,
	);
	assert.equal(typeof body.sampled, 'number');
});

test('the panel reports configured:false, not an error, with no instance', NEEDS_DB, async () => {
	// A second server with VALKEY_URL='' — the shape the UI renders as dashes.
	// Reusing adminCookie is fine: the session lives in the database, not in the
	// process. Asserting this branch rather than skipping it is deliberate; a
	// missing instance is the common local state and must not look like a fault.
	const off = await startServer({ VALKEY_URL: '' });
	try {
		const res = await get(off.baseUrl, '/api/admin/system/valkey', adminCookie);
		const raw = await res.text();
		assert.equal(res.status, 200, `disabled panel failed: ${raw}`);
		const body = JSON.parse(raw);
		assert.equal(body.configured, false);
		assert.equal(body.latencyMs, null);
		assert.equal(body.dbsize, null);
		assert.deepEqual(body.info, {
			usedMemory: null,
			maxMemory: null,
			connectedClients: null,
			opsPerSec: null,
			hitRate: null,
			evictedKeys: null,
		});
		const th = await get(off.baseUrl, '/api/admin/traffic/throttling', adminCookie);
		const tbody = JSON.parse(await th.text());
		assert.equal(tbody.valkeyUp, false);
		assert.deepEqual(tbody.concurrency, []);
	} finally {
		await off.stop();
	}
});

test('the throttling view sees a live gauge through SCAN + MGET', NEEDS_VK, async () => {
	const c = _vk();
	const key = `conc:integration-${Date.now()}`;
	try {
		// Warm the shared client first: a cold write would reject for the same
		// "Stream isn't writeable" reason the server-side _vkReady exists for.
		await _vkReady(c);
		// Large enough to land in the panel's top-50 slice deterministically. It is
		// a display gauge (in-flight count per key), read-only for routing, and it
		// is deleted here with a 30s TTL as the backstop if this process dies.
		await c.set(key, '999999', 'EX', 30);
		const res = await get(server.baseUrl, '/api/admin/traffic/throttling', adminCookie);
		const raw = await res.text();
		assert.equal(res.status, 200, `throttling failed: ${raw}`);
		const body = JSON.parse(raw);
		assert.equal(body.valkeyUp, true, 'reaching the end of the SCAN loop is the "up" assertion');
		const mine = body.concurrency.find((x) => x.key === key);
		assert.ok(
			mine,
			`the gauge written before the request must appear; got ${JSON.stringify(body.concurrency.slice(0, 5))}`,
		);
		assert.equal(mine.inFlight, 999999, 'MGET must map each value back to its key');
	} finally {
		await c.del(key).catch(() => {});
	}
});

test('a sign-up cannot set its own role', NEEDS_DB, async () => {
	// `input: false` on the declared field is load-bearing: with better-auth's
	// default the request body is the source of truth for additional fields, so
	// {"role":"admin"} in a sign-up body would be privilege escalation. better-auth
	// refuses loudly (400 FIELD_NOT_ALLOWED) rather than quietly ignoring the
	// field, so both halves are pinned: the refusal, and that no row was created.
	const email = uniqueEmail('escalate');
	const res = await fetch(`${server.baseUrl}/api/auth/sign-up/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password: 'integration-pw-123', name: 'Escalate', role: 'admin' }),
	});
	const body = await res.json().catch(() => null);
	assert.equal(res.status, 400, `a sign-up body must not set role; got ${res.status} ${JSON.stringify(body)}`);
	assert.equal(body?.code, 'FIELD_NOT_ALLOWED', `expected FIELD_NOT_ALLOWED; got ${JSON.stringify(body)}`);
	const rows = await sql`select role from "user" where email = ${email}`;
	assert.equal(rows.length, 0, 'the refused sign-up must not create a user');
});

test('the circuit-breaker list carries a state for every breaker', NEEDS_DB, async () => {
	const res = await get(server.baseUrl, '/api/admin/routing/circuit-breakers', adminCookie);
	const raw = await res.text();
	assert.equal(res.status, 200, `circuit breakers failed: ${raw}`);
	const body = JSON.parse(raw);
	assert.ok(Array.isArray(body.breakers));
	assert.ok(Array.isArray(body.providers) && Array.isArray(body.connections) && Array.isArray(body.models));
	assert.ok(Array.isArray(body.targets) && body.targets.length > 0, 'the target enum must be present');
	// null would mean the per-target GET never ran (or was skipped), which is the
	// regression the shared client introduced in the first place.
	for (const b of body.breakers) {
		assert.equal(typeof b.state, 'string', `every breaker needs a state; got ${JSON.stringify(b)}`);
		assert.ok(b.state.length > 0);
	}
});
