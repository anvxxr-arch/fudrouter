// tests/integration/p0-money-gates.test.mjs — the two live money-mint holes
// (F1 global-alias shadow, F2 self-service credit mint) and the self-threshold
// hole (F3), pinned as 403-for-member / still-open-for-operator.
//
// Why this file exists: three member-facing POST routes proved the same missing
// idea — `mustAuth` proves "a signed-in member", not "allowed to move money or
// change platform-wide routing".
//
//   F2  POST /api/pages/billing/credits/add     member minted free credit:
//       `credit_ledger` grew by the posted amount, no admin gate.
//   F1  POST /api/pages/aliases/create           member could set scope:'global'
//       and shadow the canonical slug platform-wide.
//   F3  POST /api/pages/billing/thresholds       member could set their own
//       hard-stop down to 0 (free service).
//
// Every negative case asserts the member is refused 403 (not an empty 200); a
// positive control asserts an operator (admin) is still served, so the fix
// cannot silently become a deny-all. Each negative case was checked to FAIL on
// the pre-fix code: member credits/add used to return 200 and insert a ledger
// row.
//
// Gating mirrors the rest of the suite: module-scope skip (a t.Skip in
// test.before throws in Node 22). The harness still FAILS under CI with no DSN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const NEEDS_DB = { skip: !hasDb && SKIP };

let server;
let sql;
let memberCookie; // plain user (role 'user'): each gate must refuse this
let adminCookie;  // promoted below: each gate must serve this
let modelId;      // a real model row so the alias guard is reachable

/** POST as a given session and return { status, body }. */
async function post(cookie, path, body) {
	const res = await fetch(`${server.baseUrl}${path}`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const parsed = await res.json().catch(() => null);
	return { status: res.status, body: parsed };
}

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	sql = postgres(process.env.DATABASE_URL, { max: 2 });

	// Plain member first, asserted before any promotion — a passing 403 cannot
	// be a leftover admin role from an earlier run.
	const member = await signUp(server.baseUrl, { email: uniqueEmail('member') });
	assert.equal(member.status, 200, `member sign-up failed: ${JSON.stringify(member.body)}`);
	memberCookie = member.cookie;

	const admin = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(admin.status, 200, `admin sign-up failed: ${JSON.stringify(admin.body)}`);
	adminCookie = admin.cookie;
	const email = admin.body?.user?.email;
	assert.ok(email, 'sign-up must return the user email');
	await sql`update "user" set role = 'admin' where email = ${email}`;

	// One provider + one model so the alias-create guard (which checks target
	// existence) is reachable. seeds the minimum FK tree.
	const prov = await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
		values ('prv_p0gate', 'p0gate', 'http://127.0.0.1:1', '{}', 'active', 100, now())
		on conflict (id) do nothing returning id`;
	if (prov.length === 0) await sql`select id from provider where id = 'prv_p0gate'`;
	modelId = 'mdl_p0gate';
	await sql`
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
		values ('mdl_p0gate', 'prv_p0gate', 'P0 Gate', 'p0-gate-model', 8192, '1', '1', 'USD', 'active')
		on conflict (id) do nothing`;
});

test.after(async () => {
	if (!hasDb) return;
	await server.stop();
	await sql.end();
});

// --- F2: self-service credit mint -------------------------------------------------

test('F2: a member is refused credit mint (403), not given a ledger row', NEEDS_DB, async () => {
	const res = await post(memberCookie, '/api/pages/billing/credits/add', { amount: '10' });
	assert.equal(res.status, 403, `member credits/add must be 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('F2: an admin can still move credit (the gate is not deny-all)', NEEDS_DB, async () => {
	const res = await post(adminCookie, '/api/pages/billing/credits/add', { amount: '10' });
	assert.equal(res.status, 200, `admin credits/add must be 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// --- F3: self-service hard-stop threshold -----------------------------------------

test('F3: a member is refused threshold writes (403)', NEEDS_DB, async () => {
	const res = await post(memberCookie, '/api/pages/billing/thresholds', { warn: '100', suspend: '50' });
	assert.equal(res.status, 403, `member thresholds must be 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('F3: an admin can still set thresholds (the gate is not deny-all)', NEEDS_DB, async () => {
	const res = await post(adminCookie, '/api/pages/billing/thresholds', { warn: '100', suspend: '50' });
	assert.equal(res.status, 200, `admin thresholds must be 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// --- F1: global alias shadow ------------------------------------------------------

test('F1: a member is refused a global alias (403)', NEEDS_DB, async () => {
	const res = await post(memberCookie, '/api/pages/aliases/create', {
		name: uniqueEmail('g'),
		scope: 'global',
		targets: [modelId],
	});
	assert.equal(res.status, 403, `member global-alias must be 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('F1: a member can still create an account alias (regression guard)', NEEDS_DB, async () => {
	const res = await post(memberCookie, '/api/pages/aliases/create', {
		name: uniqueEmail('a'),
		scope: 'account',
		targets: [modelId],
	});
	assert.equal(res.status, 200, `member account-alias must be 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('F1: an admin can still mint a global alias (the gate is not deny-all)', NEEDS_DB, async () => {
	const res = await post(adminCookie, '/api/pages/aliases/create', {
		name: uniqueEmail('ag'),
		scope: 'global',
		targets: [modelId],
	});
	assert.equal(res.status, 200, `admin global-alias must be 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});
