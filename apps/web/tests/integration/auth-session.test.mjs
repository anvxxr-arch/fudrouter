// tests/integration/auth-session.test.mjs — better-auth session + provisioning.
//
// The baseline records "better-auth session + Discord OAuth callback: no
// coverage". This suite drives the real /api/auth/* endpoints over HTTP and
// asserts the two things that must hold for every other management route: a
// session cookie authenticates, and sign-up provisions the workspace tree that
// /api/pages/workspace reports.
//
// Gating: every test carries `{ skip: !hasDb && '…' }`. A skip inside
// test.before does NOT work in Node 22 — the hook runs after the test bodies
// are registered, so it throws and the file reports failures. Module-scope
// gating reports them as skipped instead, which keeps `npm test --workspace
// apps/web` green for a developer with no throwaway database while the harness
// still FAILS under CI (see requireTestDatabase).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

// One predicate, shared with the harness: it throws when DATABASE_URL names the
// application database (so a prod DSN fails loudly rather than writing to
// production) and returns false when there is no DSN at all.
const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';

let server;
let cookie;
let email;

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	const signed = await signUp(server.baseUrl, { email: uniqueEmail('auth') });
	assert.equal(signed.status, 200, `sign-up failed: ${JSON.stringify(signed.body)}`);
	cookie = signed.cookie;
	email = signed.body?.user?.email;
	assert.ok(cookie, 'sign-up must return a session cookie');
});

test.after(async () => {
	await server?.stop();
});

test('sign-up provisions the workspace tree /api/pages/workspace reads', { skip: !hasDb && SKIP }, async () => {
	// The user.create.after hook (index.mjs:391-400) provisions workspace,
	// project, environments, role, member and billing account. If that hook
	// regresses, every /api/pages/* route that resolves the ownership tree
	// fails, so assert the tree exists.
	//
	// /api/pages/workspace is the endpoint that reports it: it returns
	// { workspace, owner, isOwner, projectCount, memberCount, members }
	// (pages.mjs:572). /api/pages/dashboard returns only usage totals, so it
	// cannot observe provisioning at all.
	const res = await fetch(`${server.baseUrl}/api/pages/workspace`, {
		headers: { cookie }
	});
	const raw = await res.text();
	assert.equal(res.status, 200, `workspace page failed: ${raw}`);
	const body = JSON.parse(raw);
	assert.ok(body.workspace?.id, 'a workspace must be provisioned for a new user');
	assert.ok(body.workspace?.name, 'the workspace must carry a name');
	assert.ok(
		body.projectCount >= 1,
		`the hook creates a project; got projectCount=${body.projectCount}`,
	);
	assert.ok(
		body.memberCount >= 1,
		`the hook adds the owner as a member; got memberCount=${body.memberCount}`,
	);
	assert.ok(body.isOwner === true, 'the signed-up user must own the provisioned workspace');
});

test('a session cookie authenticates; no cookie is 401', { skip: !hasDb && SKIP }, async () => {
	const authed = await fetch(`${server.baseUrl}/api/pages/workspace`, {
		headers: { cookie }
	});
	assert.equal(authed.status, 200);

	const anon = await fetch(`${server.baseUrl}/api/pages/workspace`);
	assert.equal(anon.status, 401, 'an unauthenticated request must be 401, not an empty 200');
});

test('the session survives a second request (cookie is not single-use)', { skip: !hasDb && SKIP }, async () => {
	const first = await fetch(`${server.baseUrl}/api/pages/workspace`, { headers: { cookie } });
	const second = await fetch(`${server.baseUrl}/api/pages/workspace`, { headers: { cookie } });
	assert.equal(first.status, 200);
	assert.equal(second.status, 200, 'the session cookie must be reusable');
});

test('sign-in with the right password works and the wrong one is rejected', { skip: !hasDb && SKIP }, async () => {
	const password = 'integration-pw-123';
	const good = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	assert.equal(good.status, 200, `sign-in failed: ${await good.text()}`);

	const bad = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password: 'not-the-password' })
	});
	assert.equal(bad.status, 401, 'a wrong password must be 401');
});

test('a forged session cookie is rejected, not trusted', { skip: !hasDb && SKIP }, async () => {
	const res = await fetch(`${server.baseUrl}/api/pages/workspace`, {
		headers: { cookie: 'better-auth.session_token=forged-token-value' }
	});
	assert.equal(res.status, 401, 'a forged session token must not authenticate');
});

test('the auth origin is fixed, never taken from the Host header', { skip: !hasDb && SKIP }, async () => {
	// index.mjs:594 builds the better-auth URL from ORIGIN, not the request
	// Host, so a caller cannot poison origin/redirect checks (reset links,
	// OAuth redirect_uri, CSRF-origin). docs/audit/findings.json records this
	// as an exploited finding, so this is its regression net.
	//
	// `fetch` cannot send a Host header — it is a forbidden header name and
	// undici silently drops it, which would make this test pass no matter what
	// the server did. node:http.request sets it on the wire instead.
	const { request } = await import('node:http');
	const body = await new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: server.port,
				path: '/api/auth/get-session',
				method: 'GET',
				headers: { host: 'evil.example.com', cookie }
			},
			(res) => {
				let raw = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (raw += c));
				res.on('end', () => resolve({ status: res.statusCode, raw }));
			},
		);
		req.on('error', reject);
		req.end();
	});
	assert.equal(body.status, 200, `get-session failed: ${body.raw}`);
	const parsed = JSON.parse(body.raw);
	assert.equal(
		parsed?.user?.email,
		email,
		'the session must resolve to the signed-up user even when Host is hostile',
	);
});
