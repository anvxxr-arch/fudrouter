// Unit tests for the upstream SSRF guard. `_isBlockedLiteral` is pure and
// `_assertPublic` short-circuits on a literal host (no DNS), so every case here
// is deterministic and offline. The regression these pin: the old blocklist let
// CGNAT, TEST-NET, benchmarking, multicast/reserved and IPv4-mapped IPv6
// through, and a domain resolving to a mapped-private address passed the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isBlockedLiteral, _assertPublic, _isIpOrCidr } from './ssrf.mjs';

test('_isBlockedLiteral blocks intranet hostnames and literals', () => {
	for (const h of [
		'localhost', 'foo.localhost', 'api.local', 'svc.internal',
		'metadata.google.internal', 'x.home.arpa', '',
		'127.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1',
		'::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
		'[::1]', 'localhost.'
	]) {
		assert.equal(_isBlockedLiteral(h), true, `expected ${h} blocked`);
	}
});

test('_isBlockedLiteral allows public hostnames and addresses', () => {
	for (const h of ['api.openai.com', 'example.com', '8.8.8.8', '2606:4700::1111']) {
		assert.equal(_isBlockedLiteral(h), false, `expected ${h} allowed`);
	}
});

test('_assertPublic rejects non-public upstreams', async () => {
	const mustBlock = [
		'http://127.0.0.1:9/v1',
		'http://[::ffff:127.0.0.1]:9/v1',
		'http://[::ffff:169.254.169.254]:9/v1',
		'http://100.64.0.1:9/v1', // CGNAT — the audit's headline gap
		'http://[fd00::1]:9/v1',
		'http://192.168.1.1/v1',
		'http://localhost:9/v1',
		'http://metadata.google.internal/v1',
		'http://2130706433/v1', // decimal-encoded 127.0.0.1
		'http://0x7f000001/v1' // hex-encoded 127.0.0.1
	];
	for (const u of mustBlock) {
		const r = await _assertPublic(u, false);
		assert.equal(r.ok, false, `expected ${u} refused`);
	}
});

test('_assertPublic accepts a public literal and honours allowPrivate', async () => {
	// A literal host needs no DNS lookup, so this stays offline.
	assert.equal((await _assertPublic('http://8.8.8.8/v1', false)).ok, true);
	assert.equal((await _assertPublic('http://127.0.0.1:9/v1', true)).ok, true);
});

test('_assertPublic rejects a bad scheme or unparseable URL', async () => {
	assert.equal((await _assertPublic('file:///etc/passwd', false)).ok, false);
	assert.equal((await _assertPublic('not a url', false)).ok, false);
});

test('_isIpOrCidr validates address/CIDR literals', () => {
	assert.equal(_isIpOrCidr('127.0.0.1'), true);
	assert.equal(_isIpOrCidr('10.0.0.0/8'), true);
	assert.equal(_isIpOrCidr('::1'), true);
	assert.equal(_isIpOrCidr('fd00::/8'), true);
	assert.equal(_isIpOrCidr('10.0.0.0/33'), false);
	assert.equal(_isIpOrCidr('fd00::/129'), false);
	assert.equal(_isIpOrCidr('10.0.0.0/8/8'), false);
	assert.equal(_isIpOrCidr(''), false);
	assert.equal(_isIpOrCidr('not-an-ip'), false);
});
