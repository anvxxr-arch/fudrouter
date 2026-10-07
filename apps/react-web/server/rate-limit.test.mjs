// Unit tests for the in-process fixed-window limiter.
//
// The property that matters (and was a real bug): buckets are scoped to ONE
// limiter instance. The map used to be module-level, so the strict and loose
// `/api/auth` limiters — which derive the same `ip:<x>` key — shared a counter,
// letting a burst on one surface 429 a different one. `playground` (10/min) and
// the authenticated surfaces share `u:<id>` the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from './rate-limit.mjs';

function makeRes() {
	return {
		statusCode: 200,
		body: undefined,
		headers: {},
		set(k, v) { this.headers[k] = v; return this; },
		status(c) { this.statusCode = c; return this; },
		json(o) { this.body = o; return this; }
	};
}
const req = (ip) => ({ ip });

// The middleware is async (it awaits the key), so the caller must await it
// before reading `nexted` — a synchronous call returns before `next()` fires.
async function hit(mw, ip) {
	const res = makeRes();
	let nexted = false;
	await mw(req(ip), res, () => { nexted = true; });
	return { res, nexted };
}

test('allows up to the limit, then 429s with Retry-After', async () => {
	const mw = rateLimit({ windowMs: 60_000, max: 3, key: async (r) => `ip:${r.ip}` });
	for (let i = 0; i < 3; i++) {
		const { res, nexted } = await hit(mw, '1.2.3.4');
		assert.equal(nexted, true, `request ${i + 1} should pass`);
		assert.equal(res.statusCode, 200);
	}
	const { res, nexted } = await hit(mw, '1.2.3.4');
	assert.equal(nexted, false, '4th request should be rejected');
	assert.equal(res.statusCode, 429);
	assert.equal(res.body.error.code, 'RATE_LIMITED');
	assert.ok(Number(res.headers['Retry-After']) >= 1);
});

test('separate keys have separate buckets', async () => {
	const mw = rateLimit({ windowMs: 60_000, max: 2, key: async (r) => `ip:${r.ip}` });
	assert.equal((await hit(mw, 'a')).nexted, true);
	assert.equal((await hit(mw, 'a')).nexted, true);
	assert.equal((await hit(mw, 'a')).nexted, false, 'a is exhausted');
	assert.equal((await hit(mw, 'b')).nexted, true, 'b must be unaffected');
	assert.equal((await hit(mw, 'b')).nexted, true);
	assert.equal((await hit(mw, 'b')).nexted, false);
});

test('two limiter instances with the SAME key keep independent counters', async () => {
	// Mirrors _authStrict (max 2) and _authLoose (max 5) both keying `ip:x`.
	const strict = rateLimit({ windowMs: 60_000, max: 2, key: async (r) => `ip:${r.ip}` });
	const loose = rateLimit({ windowMs: 60_000, max: 5, key: async (r) => `ip:${r.ip}` });
	assert.equal((await hit(strict, 'x')).nexted, true);
	assert.equal((await hit(strict, 'x')).nexted, true);
	assert.equal((await hit(strict, 'x')).nexted, false, 'strict is exhausted');
	// the loose limiter must NOT be affected by the strict one's counter
	for (let i = 0; i < 5; i++) {
		assert.equal((await hit(loose, 'x')).nexted, true, `loose request ${i + 1} should pass`);
	}
	assert.equal((await hit(loose, 'x')).nexted, false);
	// and the strict limiter still reports itself exhausted
	assert.equal((await hit(strict, 'x')).nexted, false);
});

test('the window resets', async () => {
	const mw = rateLimit({ windowMs: 30, max: 1, key: async (r) => `ip:${r.ip}` });
	assert.equal((await hit(mw, 'z')).nexted, true);
	assert.equal((await hit(mw, 'z')).nexted, false);
	await new Promise((r) => setTimeout(r, 45));
	assert.equal((await hit(mw, 'z')).nexted, true, 'after the window a new request passes');
});

test('the default key falls back to req.ip', async () => {
	const mw = rateLimit({ windowMs: 60_000, max: 1 });
	assert.equal((await hit(mw, '9.9.9.9')).nexted, true);
	assert.equal((await hit(mw, '9.9.9.9')).nexted, false);
	assert.equal((await hit(mw, '8.8.8.8')).nexted, true);
});
