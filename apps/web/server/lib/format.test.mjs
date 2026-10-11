// Unit tests for the ValKey access helpers in format.mjs.
//
// The baseline records no coverage here, and the one bug this code has already
// had is the one worth pinning: the raw-socket version pipelined AUTH in front of
// the command and read the reply through a bulk parser that treated "-NOAUTH" as
// "no data". The valkey panel then drew zeros for INFO/DBSIZE and `_vkPing` still
// answered "up" -- a healthy badge over an instance it could not read at all.
// "up" must mean a command completed, never "bytes arrived".
//
// Three of the cases need a specific VALKEY_URL, and the shared client is created
// once per process and reused after that (packages/platform/server/vk.ts caches
// it deliberately), so those cases run in a CHILD process with their own env.
// Without that, the file's outcome would depend on whether the developer happens
// to have VALKEY_URL exported -- a test that can be green for the wrong reason.
//
// The live case skips when VALKEY_URL is unset, which is CI. The unconfigured and
// refused-credential cases run everywhere, as their own children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _vk, _vkPing, _vkWait } from './format.mjs';

const FORMAT = fileURLToPath(new URL('./format.mjs', import.meta.url));
const hasVk = Boolean(process.env.VALKEY_URL);
const SKIP = 'VALKEY_URL is not set — live Valkey assertions skipped';

/**
 * Run a snippet against format.mjs in a fresh process with a controlled env, so
 * the client is built from the URL this test chose and nothing else.
 */
function probe(env, body) {
	// The client keeps the process alive by design (an open socket plus reconnect
	// timers), so the child must close it or spawnSync waits for an exit that never
	// comes and reports a 30s timeout as a failure. disconnect() is immediate;
	// quit() would wait on a server that may be the thing that is broken.
	const script = `import * as m from ${JSON.stringify(FORMAT)};\n${body}\nconst c = m._vk(); if (c) c.disconnect();`;
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		env: { ...process.env, ...env },
		encoding: 'utf8',
		timeout: 30_000
	});
	if (r.status !== 0) throw new Error(`child probe failed (code ${r.status}):\n${r.stderr}`);
	return r.stdout.trim();
}

// Same reason as the child probes: this process builds the shared client for the
// live case below, and an open socket would keep `node --test` from exiting after
// the last assertion — tests that pass and then hang, which reads as a CI timeout.
test.after(() => {
	if (hasVk) _vk()?.disconnect();
});

test('_vkWait resolves with the value when the promise is faster than the deadline', async () => {
	assert.equal(await _vkWait(Promise.resolve('pong'), 1000, 'ping'), 'pong');
});

test('_vkWait rejects with a labelled timeout instead of hanging', async () => {
	// A connected-but-silent Valkey is the case the shared client cannot cover:
	// it holds the request open forever. This is the bound.
	const started = Date.now();
	await assert.rejects(_vkWait(new Promise(() => {}), 50, 'ping'), /valkey ping timed out after 50ms/);
	assert.ok(Date.now() - started < 2000, 'the deadline must be the thing that ends it');
});

test('_vkWait propagates the command error, not a timeout, when one arrives first', async () => {
	// A rejected command (WRONGPASS) must surface as itself: the callers tell
	// "unreachable" from "refused" by nothing but this.
	await assert.rejects(_vkWait(Promise.reject(new Error('WRONGPASS invalid username-password pair')), 1000, 'ping'), /WRONGPASS/);
});

test('_vkPing is "not configured" when VALKEY_URL is empty', () => {
	// Runs everywhere, including CI, which has no Valkey: this is the deployment
	// the whole path is supposed to survive untouched.
	assert.equal(probe({ VALKEY_URL: '' }, 'console.log(await m._vkPing())'), 'not configured');
});

test('_vkPing is "down", never "up", when the credential is refused', () => {
	// The regression this file exists for. A wrong password must not paint a
	// healthy badge, and neither must an unreachable host -- both land in the
	// same catch, so this assertion holds with or without a live instance.
	const url = 'redis://:definitely-not-the-password@127.0.0.1:6379/1';
	assert.equal(probe({ VALKEY_URL: url }, 'console.log(await m._vkPing())'), 'down');
});

test('_vkPing is "up" as the FIRST command in a cold process', { skip: !hasVk && SKIP }, () => {
	// The regression the first live run caught: the client is lazy and refuses to
	// queue, so without _vkReady the very first command in a fresh process is
	// rejected ("Stream isn't writeable and enableOfflineQueue options is false")
	// and a healthy instance is reported "down". A fresh child is the only way to
	// be cold on purpose.
	assert.equal(probe({ VALKEY_URL: process.env.VALKEY_URL }, 'console.log(await m._vkPing())'), 'up');
});

test('the panel path reads and writes a live instance', { skip: !hasVk && SKIP }, async () => {
	// The same calls the three admin call sites make, in the same order, against
	// the real instance. The scan/mget pair is the throttling panel, info/dbsize
	// is the valkey panel, get is the circuit-breaker state.
	const c = _vk();
	assert.ok(c, 'VALKEY_URL is set, so a client must exist');
	assert.equal(await _vkPing(), 'up');

	// Namespaced and TTL'd so a crash cannot leave debris in a live keyspace;
	// deleted in the finally as the normal path.
	const key = `fudrouter:selftest:${Date.now()}`;
	try {
		await _vkWait(c.set(key, '1', 'PX', 10_000), 4000, 'set');
		assert.equal(await _vkWait(c.get(key), 4000, 'get'), '1');

		const [cursor, keys] = await _vkWait(c.scan('0', 'MATCH', 'fudrouter:selftest:*', 'COUNT', 10), 4000, 'scan');
		assert.equal(typeof cursor, 'string', 'SCAN must return a cursor as a string');
		assert.ok(keys.includes(key), `SCAN must find the key just written; got ${JSON.stringify(keys)}`);

		assert.deepEqual(await _vkWait(c.mget(key), 4000, 'mget'), ['1']);
		assert.match(String(await _vkWait(c.info(), 4000, 'info')), /used_memory:/, 'INFO must carry the fields the panel parses');
		assert.ok(Number(await _vkWait(c.dbsize(), 4000, 'dbsize')) >= 1);
	} finally {
		await c.del(key).catch(() => {});
	}
});
