// tests/integration/playground-compare.test.mjs — the comparison relay's fan-out contract.
//
// Why this file exists: `POST /api/playground/compare` (playground.mjs) is the
// N-model sibling of the single-model relay pinned by playground-stream.test.mjs.
// It mints ONE run key PER MODEL, runs the upstream calls concurrently, and
// wraps every relayed SSE line as {"model":…,"chunk":…} so the client can
// attribute bytes to a column. The invariants a silent regression breaks:
//
//  1. ATTRIBUTION. Every chunk frame and every metrics frame must carry the
//     model it belongs to. A frame without `model` is unusable by the SPA's
//     column renderer — the whole point of the multiplexed stream.
//  2. FAN-OUT. Two models in the request must produce exactly two upstream
//     calls with two DIFFERENT minted bearer keys (one run key per model, not
//     one shared key), and each call must carry that model's slug.
//  3. METRICS PER MODEL. Each model gets exactly one `event: metrics` frame,
//     emitted when ITS upstream ends — not one frame for the whole run.
//  4. RECLAIM. Every minted key is reclaimed even when the client disconnects
//     mid-run (the finally in settle()).
//  5. LINE INTEGRITY. A chunk frame always carries ONE COMPLETE upstream SSE
//     line. A TCP read can end mid-line, so the relay buffers the partial
//     tail across reads; wrapping a half line as its own frame would make the
//     client's JSON.parse of that frame body fail and silently lose the text.
//  6. ERROR-PATH FLUSH. The buffer must also be flushed when the upstream
//     dies mid-line: reader.read() rejects, settle() lands in its catch, and
//     a half line buffered before the throw is lost unless the catch flushes
//     it — the same silent loss as invariant 5, on the error path.
//
// The stub upstream echoes the requested model into its stream, so the test
// can prove the relay attributed the right bytes to the right model.
//
// Gating: module-scope, like every other integration test here — a skip
// inside test.before throws in Node 22 (auth-session.test.mjs:9-14).
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

// The stub upstream: one SSE stream per call, echoing the requested model so
// attribution is provable. `delay` staggers completion so the multiplexed
// interleave is real, not accidental.
let upstream;
let upstreamPort;
const upstreamBodies = [];
const upstreamAuths = [];

function startUpstream() {
	return new Promise((resolve) => {
		upstream = http.createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
			upstreamBodies.push(body);
			upstreamAuths.push(req.headers.authorization ?? '');
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'x-fudrouter-request-id': `req_cmp_${body.model}`
			});
			if (body.model === 'split-model') {
				// One SSE frame written as two TCP writes with a pause
				// between them, so the relay's reader.read() sees the
				// half line `data: {"choices":[{"delta":` as its own
				// chunk. Only a buffer carried ACROSS reads can hold it
				// back until the line completes; a per-read split wraps
				// each half as its own frame and the client's JSON.parse
				// of both fails, losing the text. No echo line here, so
				// this model's only data frame is the split one.
				res.write('data: {"choices":[{"delta":');
				await new Promise((r) => setTimeout(r, 30));
				res.write('{"content":"split-ok"}}]}\n\n');
			} else if (body.model === 'die-mid-line') {
				// A half line with NO trailing newline, then the socket is
				// destroyed: the relay's reader.read() rejects and control
				// lands in settle()'s catch. The buffered half line is still
				// owed to the client — without a catch-path flush the text
				// dies with the socket, the same silent loss the buffer
				// exists to prevent, just on the error path.
				res.write('data: {"choices":[{"delta":{"content":"half-');
				await new Promise((r) => setTimeout(r, 30));
				res.socket.destroy();
				return;
			} else {
				res.write(`data: {"choices":[{"delta":{"content":"hello-from-${body.model}"}}]}\n\n`);
			}
			if (body.model.startsWith('hold-')) {
				// Never ends until the test says so: the client disconnects
				// while this upstream call is provably still in flight.
				await holdModel();
			}
			await new Promise((r) => setTimeout(r, body.model === 'slow-model' ? 150 : 0));
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
	const signed = await signUp(server.baseUrl, { email: uniqueEmail('pg-compare') });
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

function compare(models, { signal } = {}) {
	return fetch(`${server.baseUrl}/api/playground/compare`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ models, messages: [{ role: 'user', content: 'hi' }] }),
		signal
	});
}

test('compare rejects fewer than two distinct models', { skip: !hasDb && SKIP }, async () => {
	const res = await compare(['only-one']);
	assert.equal(res.status, 400, 'a one-model compare must be a 400');
	const body = await res.json();
	assert.match(body.error?.message ?? '', /2–3/, 'the error must say why');
});

test('chunks and metrics are attributed per model and each model gets one metrics frame', { skip: !hasDb && SKIP }, async () => {
	const res = await compare(['fast-model', 'slow-model']);
	assert.equal(res.status, 200, 'relay must answer 200');
	assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		raw += decoder.decode(r.value, { stream: true });
	}

	// Parse the multiplexed frames.
	const frames = [];
	for (const block of raw.split('\n\n')) {
		if (!block) continue;
		const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'chunk';
		const data = /^data: (.*)$/m.exec(block)?.[1];
		assert.ok(data, `every frame must carry data, got ${JSON.stringify(block)}`);
		frames.push({ event, payload: JSON.parse(data) });
	}

	// Every frame names its model.
	for (const f of frames) {
		assert.ok(f.payload.model, `a ${f.event} frame arrived without a model attribution`);
		assert.ok(['fast-model', 'slow-model'].includes(f.payload.model), `unknown model ${f.payload.model}`);
	}

	// The chunk frames carry the right model's text.
	const fastChunks = frames.filter((f) => f.event === 'chunk' && f.payload.model === 'fast-model');
	assert.ok(fastChunks.length > 0, 'fast-model must have chunk frames');
	assert.match(fastChunks[0].payload.chunk, /hello-from-fast-model/, 'fast-model chunks must be fast-model text');

	// Exactly one metrics frame per model.
	for (const model of ['fast-model', 'slow-model']) {
		const metrics = frames.filter((f) => f.event === 'metrics' && f.payload.model === model);
		assert.equal(metrics.length, 1, `${model} must get exactly one metrics frame, got ${metrics.length}`);
		for (const key of ['requestId', 'latencyMs', 'ttftMs', 'costMicro', 'status']) {
			assert.ok(key in metrics[0].payload, `the metrics frame must carry ${key}`);
		}
		assert.equal(metrics[0].payload.requestId, `req_cmp_${model}`, 'the request id must come from that model\'s upstream');
	}
});

test('two models fan out to two upstream calls with distinct minted keys', { skip: !hasDb && SKIP }, async () => {
	const before = upstreamBodies.length;
	const beforeAuths = upstreamAuths.length;
	const res = await compare(['alpha', 'beta']);
	const reader = res.body.getReader();
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
	}
	assert.equal(upstreamBodies.length - before, 2, 'two models must produce exactly two upstream calls');
	assert.equal(upstreamBodies[before].model, 'alpha', 'each call must carry its own model slug');
	assert.equal(upstreamBodies[before + 1].model, 'beta', 'each call must carry its own model slug');
	assert.equal(upstreamBodies[before].stream, true, 'each call must be a stream');
	const keys = [upstreamAuths[beforeAuths], upstreamAuths[beforeAuths + 1]];
	assert.notEqual(keys[0], keys[1], 'each model must get its own minted run key, not one shared key');
	assert.match(keys[0], /^Bearer sk-ar-/, 'the minted key must be an sk-ar- run key');
});

// The stub holds a model's stream open until released, so the client can
// disconnect while the upstream call is provably still in flight — the state
// where the old close handler (body.cancel only) left the fetch running and
// the minted key live until its 5-minute TTL.
let releaseHolds = [];
function holdModel() {
	return new Promise((resolve) => {
		releaseHolds.push(resolve);
	});
}

test('a client disconnect mid-run aborts the upstream calls and reclaims every key', { skip: !hasDb && SKIP }, async () => {
	// Scope the assertion to keys minted BY THIS RUN: the throwaway DB may
	// carry leftovers from earlier invocations, and reclaim deletes rows.
	const [{ n: before }] = await sql`select count(*)::int as n from api_key where policy->>'playground' = 'true'`;

	// Both models hold their streams open, so neither run can complete on its
	// own: the only way the keys get reclaimed is the disconnect path.
	const client = new AbortController();
	const res = await compare(['hold-a', 'hold-b'], { signal: client.signal });
	assert.equal(res.status, 200, 'relay must answer 200 before the client disconnects');

	// Read until the first bytes arrive, proving the runs are in flight, then
	// abort the request. The abort is what closes the socket; reader.cancel()
	// alone can leave an HTTP/1.1 connection reusable and the server would
	// never see a disconnect.
	const reader = res.body.getReader();
	const first = await reader.read();
	assert.equal(first.done, false, 'the relay must have flushed a chunk before the hold');
	const raw = new TextDecoder().decode(first.value);
	assert.match(raw, /hold-a/, 'the first flushed chunk must be attributed to a model');

	client.abort();
	reader.cancel().catch(() => undefined);

	// Give the server time to observe the close, abort both fetches, and run
	// the per-model reclaims in settle()'s finally.
	await new Promise((r) => setTimeout(r, 600));

	// A leak means this run's keys survive, so the count grows. A DECREASE is a
	// leftover from an earlier run being reclaimed inside this window, which is
	// cleanup, not a leak — asserting exact equality made the gate fail on a
	// green run. `<=` is the invariant: no key minted here outlives its client.
	const [{ n: after }] = await sql`select count(*)::int as n from api_key where policy->>'playground' = 'true'`;
	assert.ok(after <= before, `every minted run key must be reclaimed after a client disconnect, ${after - before} leaked`);

	// An aborted run emits no metrics frame: the client is gone, so an
	// UPSTREAM_ERROR frame would be a lie about a deliberate disconnect.
	assert.ok(!raw.includes('event: metrics'), 'an aborted run must not emit a metrics frame');

	// Release the held upstreams so the stub finishes and the server settles.
	for (const release of releaseHolds) release();
	releaseHolds = [];
	await new Promise((r) => setTimeout(r, 100));
});

test('a line split across two TCP writes is relayed as one frame', { skip: !hasDb && SKIP }, async () => {
	// The stub writes ONE SSE line as two res.write() calls with a pause
	// between them, so the relay's reader.read() returns the half line
	// `data: {"choices":[{"delta":` as its own chunk. The relay must
	// hold that tail in a buffer carried ACROSS reads and emit the completed
	// line as a single chunk frame. Without the buffer the client receives two
	// frames whose bodies are both invalid JSON, and the text is lost — the
	// column stays empty with no error anywhere.
	// Verified by mutation: reverting the relay to a per-read split makes this
	// test fail with "got 2" — the half line arrives as its own frame.
	const res = await compare(['split-model', 'fast-model']);
	assert.equal(res.status, 200, 'relay must answer 200');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		raw += decoder.decode(r.value, { stream: true });
	}

	const frames = [];
	for (const block of raw.split('\n\n')) {
		if (!block) continue;
		const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'chunk';
		const data = /^data: (.*)$/m.exec(block)?.[1];
		assert.ok(data, `every frame must carry data, got ${JSON.stringify(block)}`);
		frames.push({ event, payload: JSON.parse(data) });
	}

	// The stub writes no echo line for split-model, so its only DATA frame is
	// the one split across two TCP writes. `data: [DONE]` is a chunk frame too
	// and is not part of this invariant.
	const splitChunks = frames.filter(
		(f) => f.event === 'chunk' && f.payload.model === 'split-model' && f.payload.chunk !== 'data: [DONE]'
	);
	assert.equal(splitChunks.length, 1, `the split line must arrive as exactly one chunk frame, got ${splitChunks.length}`);
	assert.equal(
		splitChunks[0].payload.chunk,
		'data: {"choices":[{"delta":{"content":"split-ok"}}]}',
		'the one chunk frame must carry the complete line, not a half line'
	);
	// The frame body parses as the delta the client renders.
	const body = JSON.parse(splitChunks[0].payload.chunk.replace(/^data: ?/, ''));
	assert.equal(body.choices[0].delta.content, 'split-ok', 'the reassembled line must parse to the full delta');

	// No split-model frame may carry a truncated body: a half line wrapped as
	// its own frame is the silent-loss failure this buffer exists to prevent.
	for (const f of splitChunks) {
		assert.doesNotMatch(f.payload.chunk, /"content":"split-$/, 'a half line must never be wrapped as its own chunk frame');
		assert.doesNotMatch(f.payload.chunk, /^\s*data: \{"choices":\[\{"delta":\s*$/, 'a chunk frame must never end mid-line');
	}
});

test('an upstream that dies mid-line still flushes the buffered half line', { skip: !hasDb && SKIP }, async () => {
	// The stub writes a half line with no trailing newline and then destroys
	// the socket, so reader.read() rejects and settle() lands in its catch.
	// The half line buffered before the throw must still reach the client:
	// without a catch-path flush the text dies with the socket — the same
	// silent loss as the split-line invariant, on the error path.
	const res = await compare(['die-mid-line', 'fast-model']);
	assert.equal(res.status, 200, 'relay must answer 200');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		raw += decoder.decode(r.value, { stream: true });
	}

	const frames = [];
	for (const block of raw.split('\n\n')) {
		if (!block) continue;
		const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'chunk';
		const data = /^data: (.*)$/m.exec(block)?.[1];
		assert.ok(data, `every frame must carry data, got ${JSON.stringify(block)}`);
		frames.push({ event, payload: JSON.parse(data) });
	}

	// The stub writes no echo line for die-mid-line, so its only data frame
	// is the flushed half line. `data: [DONE]` never arrives: the socket died.
	const diedChunks = frames.filter(
		(f) => f.event === 'chunk' && f.payload.model === 'die-mid-line' && f.payload.chunk !== 'data: [DONE]'
	);
	assert.equal(diedChunks.length, 1, `the buffered half line must be flushed exactly once, got ${diedChunks.length}`);
	assert.equal(
		diedChunks[0].payload.chunk,
		'data: {"choices":[{"delta":{"content":"half-',
		'the flushed frame must carry the half line the upstream died on'
	);

	// The error path still reports: a dead upstream must not silence metrics.
	const diedMetrics = frames.filter((f) => f.event === 'metrics' && f.payload.model === 'die-mid-line');
	assert.equal(diedMetrics.length, 1, `the error path must still emit one metrics frame, got ${diedMetrics.length}`);
});
