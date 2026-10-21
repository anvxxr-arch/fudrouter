// tests/integration/auth-session.test.mjs — better-auth session + provisioning.
//
// The baseline records "better-auth session + Discord OAuth callback: no
// coverage". This suite drives the real /api/auth/* endpoints over HTTP and
// asserts the two things that must hold for every other management route: a
// session cookie authenticates, and sign-up provisions the billing account
// that /api/pages/billing reads.
//
// Gating: the module evaluates `integrationEnabled()` once at load. With no
// DATABASE_URL outside CI it returns false, `test.before` returns early, and
// every test body carries `{ skip: !hasDb && SKIP }` so the file reports
// skipped rather than failing on a server that was never started. Under
// CI=true with no DSN the predicate itself THROWS (harness.mjs:72) — a silent
// skip would let the pipeline go green while the control plane was never
// exercised, so CI fails loudly by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

// One predicate, shared with the harness: it throws when DATABASE_URL names the
// application database (so a prod DSN fails loudly rather than writing to
// production) and returns false when there is no DSN at all.
const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';

let server;
let sql;
let cookie;
let email;

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	const signed = await signUp(server.baseUrl, { email: uniqueEmail('auth') });
	assert.equal(signed.status, 200, `sign-up failed: ${JSON.stringify(signed.body)}`);
	cookie = signed.cookie;
	email = signed.body?.user?.email;
	assert.ok(cookie, 'sign-up must return a session cookie');
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

test('sign-up provisions the billing account /api/pages/billing reads', { skip: !hasDb && SKIP }, async () => {
	// The user.create.after hook (index.mjs provisionAccount) creates the billing
	// account and nothing else — migration 0019 made the user account the tenant,
	// so there is no workspace tree left to provision.
	//
	// The read path self-heals (`billingAccountFor` inserts on conflict do
	// nothing), so asserting the 200 alone would pass even with the hook broken.
	// The row must exist BEFORE the first read: query it directly.
	const rows = await sql`
		select ba.id, ba.currency from billing_account ba
		join "user" u on u.id = ba.user_id
		where u.email = ${email}`;
	assert.equal(rows.length, 1, 'sign-up must provision exactly one billing account');
	assert.equal(rows[0].currency, 'USD');

	const res = await fetch(`${server.baseUrl}/api/pages/billing`, { headers: { cookie } });
	const raw = await res.text();
	assert.equal(res.status, 200, `billing page failed: ${raw}`);
	const body = JSON.parse(raw);
	assert.equal(body.currency, 'USD', 'the billing account must carry a currency');
	assert.equal(body.canWrite, true, 'the account owner must be able to write billing settings');
	assert.equal(typeof body.balanceMicro, 'string', 'the billing page must report a balance');
	assert.equal(typeof body.period?.spentMicro, 'string', 'the billing page must report period spend');
});

test('a session cookie authenticates; no cookie is 401', { skip: !hasDb && SKIP }, async () => {
	const authed = await fetch(`${server.baseUrl}/api/pages/account`, {
		headers: { cookie }
	});
	assert.equal(authed.status, 200);

	const anon = await fetch(`${server.baseUrl}/api/pages/account`);
	assert.equal(anon.status, 401, 'an unauthenticated request must be 401, not an empty 200');
});

test('the session survives a second request (cookie is not single-use)', { skip: !hasDb && SKIP }, async () => {
	const first = await fetch(`${server.baseUrl}/api/pages/account`, { headers: { cookie } });
	const second = await fetch(`${server.baseUrl}/api/pages/account`, { headers: { cookie } });
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
	const res = await fetch(`${server.baseUrl}/api/pages/account`, {
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

// AUTH-1 (memory DoS on the unauthenticated auth surface).
//
// index.mjs's app.all('/api/auth/{*path}') runs BEFORE express.json({limit:'1mb'}),
// so it buffers the raw body itself (better-auth needs the raw stream). It had
// no size gate, so an unauthenticated client could stream an unlimited body and
// exhaust server memory. The handler now (a) 413s a declared content-length
// over 1mb before reading a byte, and (b) stops consuming and destroys the
// request once a chunked body crosses 1mb mid-stream.
//
// Both shapes matter: a content-length-only check is bypassed by a chunked
// body (no content-length header), and a streaming-only check still lets a
// declared-length body buffer up to its lie. A normal-sized body must keep
// working, or the fix breaks sign-in/sign-up (better-auth consumes the raw
// stream) — so the small-body control below runs the same endpoint.
test('auth rejects a body over 1mb by content-length, before consuming it', { skip: !hasDb && SKIP }, async () => {
	const res = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// 2MB of padding: over the 1mb cap, and large enough that a server that
		// buffers it would not answer instantly.
		body: JSON.stringify({ email, password: 'x'.repeat(2 * 1024 * 1024) })
	});
	assert.equal(res.status, 413, `an over-limit declared body must be 413, got ${res.status}`);
});

test('auth destroys a chunked body that crosses 1mb mid-stream', { skip: !hasDb && SKIP }, async () => {
	// fetch would set content-length for a buffered body, so this drops to
	// node:http to send transfer-encoding: chunked (no content-length header).
	// That is the bypass a content-length-only check cannot catch.
	const { request } = await import('node:http');
	const outcome = await new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: server.port,
				path: '/api/auth/sign-in/email',
				method: 'POST',
				headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
			},
			(res) => {
				let raw = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (raw += c));
				res.on('end', () => resolve({ status: res.statusCode, raw }));
			},
		);
		req.on('error', () => resolve({ status: 0, raw: 'client stream error (expected after server destroys)' }));
		// 4MB in 64KB chunks, well past the 1mb cap. The server stops consuming
		// and destroys the request; the client may see the 413 or an EPIPE once
		// its writes hit the closed socket, but it must never see a 200.
		const chunk = Buffer.alloc(64 * 1024, 97);
		let sent = 0;
		const write = () => {
			while (sent < 4 * 1024 * 1024) { sent += chunk.length; if (!req.write(chunk)) break; }
			if (sent < 4 * 1024 * 1024) req.once('drain', write);
			else req.end();
		};
		write();
	});
	assert.notEqual(outcome.status, 200, 'a chunked over-limit body must never be accepted');
	if (outcome.status !== 0) assert.equal(outcome.status, 413, `expected 413, got ${outcome.status}: ${outcome.raw}`);
});

test('a normal-sized body still works (the cap must not break sign-in)', { skip: !hasDb && SKIP }, async () => {
	const res = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password: 'integration-pw-123' })
	});
	assert.equal(res.status, 200, `a small body must still reach better-auth: ${await res.text()}`);
});

test('the email endpoint is closed outside NODE_ENV=test', { skip: !hasDb && SKIP }, async () => {
	// The unit test in lib/auth-config.test.mjs pins the PURE function and is
	// thorough — 'test' only, near-miss spellings, missing NODE_ENV. What it cannot
	// see is the call site: index.mjs reads process.env.NODE_ENV, so a regression
	// there (a hardcoded 'test', a wrong variable) would open email/password
	// sign-in in production with the whole suite green.
	//
	// The Origin header is LOAD-BEARING, and this test was first written without
	// it — which made it pass for the wrong reason. better-auth refuses a
	// state-changing request that carries no Origin with
	// 403 MISSING_OR_NULL_ORIGIN, in EVERY environment, so "not 200 and no cookie"
	// held whether the gate was open or shut: measured with the call site
	// deliberately forced to `emailAuthEnabled('test')`, both environments
	// answered 403 and this test stayed green. With a trusted Origin the two
	// diverge — gate shut answers 400 EMAIL_PASSWORD_SIGN_UP_DISABLED, gate open
	// answers 200 with a session cookie.
	//
	// So the control below is not decoration: it runs the SAME request against the
	// test-env server, and if the request shape ever stops being able to succeed
	// there, the control fails instead of the assertion passing vacuously.
	const post = (baseUrl, email) =>
		fetch(`${baseUrl}/api/auth/sign-up/email`, {
			method: 'POST',
			// http://127.0.0.1:3000 is one of the two literals in index.mjs's
			// trustedOrigins for every non-production NODE_ENV.
			headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
			body: JSON.stringify({ email, password: 'integration-pw-123', name: 'Closed' })
		});

	const dev = await startServer({ NODE_ENV: 'development' });
	try {
		const closed = await post(dev.baseUrl, uniqueEmail('closed'));
		const cookies = closed.headers.getSetCookie?.() ?? [];
		assert.notEqual(closed.status, 200, 'email sign-up answered 200 outside NODE_ENV=test');
		assert.equal(cookies.length, 0, `email sign-up issued a session cookie: ${cookies.join('; ')}`);

		const open = await post(server.baseUrl, uniqueEmail('open'));
		assert.equal(open.status, 200, 'control: the same request must succeed under NODE_ENV=test');
		assert.ok(
			(open.headers.getSetCookie?.() ?? []).length > 0,
			'control: the same request must issue a session cookie under NODE_ENV=test'
		);
	} finally {
		await dev.stop();
	}
});
