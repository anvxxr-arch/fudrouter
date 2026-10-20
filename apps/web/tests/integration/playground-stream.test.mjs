// tests/integration/playground-stream.test.mjs — the SSE relay's flush contract.
//
// Why this file exists: `POST /api/playground/stream` (playground.mjs:323) is the
// only path in the product that crosses planes — Express mints a 5-minute run
// key, POSTs `stream:true` to the Go router, relays SSE byte-for-byte, appends
// one `event: metrics` frame read back from `request_log`, and always reclaims
// the key. It had ZERO coverage: no test imported playground.mjs, no test
// opened a connection to the route, and the repo's own baseline records the hole
// (docs/migration/2026-10-10-phase0-baseline.md:106 — "SSE / streaming flush
// semantics | partly — no test asserts the first event arrives without
// buffering"). The Go plane has the analogous coverage
// (proxy/stream_test.go:19 TestStreamNotCutByClientTimeout with a ~3s dribbling
// upstream); the Node relay did not.
//
// The two invariants pinned here are the ones a silent regression breaks:
//
//  1. FLUSH. The relay must write each upstream chunk as it arrives
//     (playground.mjs:413-420 — `getReader()` + `res.write(Buffer.from(value))`
//     inside an unbounded loop), NOT accumulate and write once at the end. A
//     buffering regression is invisible to any assertion that only reads the
//     finished body: the bytes are identical, only their arrival time changes,
//     and TTFT — the one metric this path exists to produce — goes to the total
//     latency. So the test holds the upstream OPEN after its first chunk and
//     asserts the client observes that chunk before the upstream completes.
//     No wall-clock threshold anywhere: the assertion is ordering, not duration.
//
//  2. METRICS FRAME. After the upstream stream ends the relay appends exactly
//     one `event: metrics` frame (playground.mjs:421-425) merged from
//     `request_log` via pgFetchRunMetrics (playground.mjs:216-249). The SPA's
//     playground panel reads that frame for its numbers (src/lib/api.ts:119-124
//     declares ttftMs/latencyMs/costMicro), so dropping or reordering it is a
//     silent data loss, not a visible error.
//
// Upstream injection: the relay's upstream base is `ROUTER_BASE_URL`
// (playground.mjs:47-48, default http://127.0.0.1:8100), and the harness spreads
// caller env into the spawned server (harness.mjs:132-134), so
// `startServer({ ROUTER_BASE_URL })` points the real route at a stub `node:http`
// server this file controls. That is the whole seam — no production code changes,
// no import of index.mjs (it calls app.listen at import time, harness.mjs:18-20).
//
// Gating: module-scope, like every other integration test here — a skip inside
// test.before throws in Node 22 (auth-session.test.mjs:9-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';

let server;
let sql;
let cookie;

// The stub upstream. `hold` keeps the response open after the first chunk so the
// flush assertion can observe arrival-before-completion; `end` finishes normally
// so the metrics-frame assertion sees a completed stream.
let upstream;
let upstreamPort;
let releaseHold;
const upstreamBodies = [];

function startUpstream() {
	return new Promise((resolve) => {
		upstream = http.createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
			upstreamBodies.push(body);
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'x-fudrouter-request-id': 'req_pg_probe'
			});
			res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
			if (body.model === 'hold') {
				// Never ends until the test says so. The relay must have flushed the
				// chunk above by now, or the client below cannot have seen it.
				await new Promise((r) => {
					releaseHold = r;
				});
			}
			res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
			res.write('data: [DONE]\n\n');
			res.end();
		});
		upstream.listen(0, '127.0.0.1', () => {
			upstreamPort = upstream.address().port;
			resolve();
		});
	});
}

test.before(async () => {
	if (!hasDb) return;
	await startUpstream();
	server = await startServer({ ROUTER_BASE_URL: `http://127.0.0.1:${upstreamPort}` });
	const signed = await signUp(server.baseUrl, { email: uniqueEmail('pg-stream') });
	assert.equal(signed.status, 200, `sign-up failed: ${JSON.stringify(signed.body)}`);
	cookie = signed.cookie;
	assert.ok(cookie, 'sign-up must return a session cookie');
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
});

test.after(async () => {
	await sql?.end({ timeout: 5000 });
	await server?.stop();
	await new Promise((r) => upstream?.close(r));
});

/** POST a run and return the raw response, so the caller can read it incrementally. */
function run(model) {
	return fetch(`${server.baseUrl}/api/playground/stream`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
	});
}

test('the first SSE event reaches the client before the upstream completes', { skip: !hasDb && SKIP }, async () => {
	// The relay must flush per chunk (playground.mjs:413-420). If it accumulated
	// and wrote once at the end, this read would block until the upstream was
	// released — which is exactly the TTFT-destroying regression.
	const res = await run('hold');
	// The message must NOT read the body: on a held stream `await res.text()`
	// never resolves, so an eager read here deadlocks the test until Node's
	// timeout and reports a hang instead of the real failure. The status is
	// already known; the body is asserted below, chunk by chunk.
	assert.equal(res.status, 200, 'relay must answer 200 for a streaming upstream');
	assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

	const reader = res.body.getReader();
	const first = await reader.read();
	assert.equal(first.done, false, 'the upstream is still open, so a flushed relay has already sent a chunk');
	const text = new TextDecoder().decode(first.value);
	assert.match(text, /data: /, `the first relayed bytes must be an SSE data frame, got ${JSON.stringify(text)}`);

	// The upstream is provably still mid-stream: it has not written `second` or
	// `[DONE]` yet, and its handler is parked on the hold promise.
	assert.ok(!text.includes('second'), 'the second chunk cannot have arrived — the upstream has not sent it');
	assert.ok(!text.includes('[DONE]'), 'the terminator cannot have arrived — the upstream has not ended');

	// Release, then drain so the server side finishes and the run key is reclaimed.
	releaseHold?.();
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
	}
});

test('one event: metrics frame is appended after the upstream stream ends', { skip: !hasDb && SKIP }, async () => {
	const res = await run('end');
	// No `await res.text()` in the message: it would consume and lock res.body,
	// so the getReader() below would throw ERR_INVALID_STATE.
	assert.equal(res.status, 200, 'relay must answer 200');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		raw += decoder.decode(r.value, { stream: true });
	}

	// The relayed upstream bytes come first, verbatim.
	assert.match(raw, /data: \{"choices":\[\{"delta":\{"content":"first"\}\}\]\}\n\n/, 'the first upstream chunk must be relayed verbatim');
	assert.match(raw, /data: \[DONE\]\n\n/, 'the upstream terminator must be relayed verbatim');

	// Then exactly one metrics frame, last.
	const frames = raw.split('\n\n').filter((f) => f.startsWith('event: metrics'));
	assert.equal(frames.length, 1, `exactly one event: metrics frame must be appended, got ${frames.length}`);
	assert.ok(raw.trimEnd().endsWith(frames[0]), 'the metrics frame must be the LAST frame in the stream');

	const payload = JSON.parse(frames[0].slice('event: metrics\ndata: '.length));
	// The shape the SPA's playground panel reads (src/lib/api.ts:119-124).
	for (const key of ['requestId', 'provider', 'actualModel', 'tokensIn', 'tokensOut', 'ttftMs', 'latencyMs', 'costMicro', 'fallback', 'attempts']) {
		assert.ok(key in payload, `the metrics frame must carry ${key}`);
	}
	assert.equal(payload.requestId, 'req_pg_probe', 'the request id must come from the upstream response header');
});

test('the relay asks the upstream for a stream and carries the minted run key', { skip: !hasDb && SKIP }, async () => {
	// pgBuildChatBody (playground.mjs:157-167) sets `stream: true`; the run key is
	// minted per run (pgMintRunKey, playground.mjs:278-322) and sent as the
	// bearer. A relay that dropped either would silently degrade to a buffered or
	// unauthenticated upstream call.
	// Count the DELTA, not the absolute length: `upstreamBodies` is module-scoped
	// and every test in this file appends to it, so by the time this one runs the
	// array already holds the earlier tests' calls. An absolute `=== 1` passes
	// only when this file is run in isolation.
	const before = upstreamBodies.length;
	await run('end').then(async (res) => {
		const reader = res.body.getReader();
		for (;;) {
			const r = await reader.read();
			if (r.done) break;
		}
	});
	assert.equal(upstreamBodies.length - before, 1, 'the stub upstream must have received exactly one call');
	assert.equal(upstreamBodies[before].stream, true, 'the relay must POST stream:true to the data plane');
});
