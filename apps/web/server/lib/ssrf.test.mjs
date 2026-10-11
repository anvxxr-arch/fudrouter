// Unit tests for the upstream SSRF guard AS THE SERVER ACTUALLY RUNS IT.
//
// These import through ./platform-ts.mjs, which is what admin.mjs imports, so a
// regression here is a regression in the live guard. They used to import the
// console's own copies from ./ssrf.mjs -- copies that nothing on the live path
// called -- which is how the two lists drifted apart without a test noticing.
//
// `_isBlockedLiteral` is pure and `_assertPublic` short-circuits on a literal
// host (no DNS), so every case below is deterministic and offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isBlockedLiteral, _assertPublic } from './platform-ts.mjs';
import { _isIpOrCidr } from './validate.mjs';

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

test('_isBlockedLiteral blocks the ranges the short list missed', () => {
	// Each of these passed the blocklist this guard used to carry. The first
	// three are the ones with teeth: NAT64/6to4 carry the address they will
	// actually connect to, so on an IPv6-only or NAT64 host
	// 64:ff9b::a9fe:a9fe reaches the metadata service.
	for (const h of [
		'64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254 (cloud metadata)
		'64:ff9b::7f00:1',    // NAT64 of 127.0.0.1
		'64:ff9b::a00:1',     // NAT64 of 10.0.0.1
		'2002:7f00:1::',      // 6to4 of 127.0.0.1
		'2002:c0a8:101::',    // 6to4 of 192.168.1.1
		'2002::1',            // 6to4 relay
		'::0.0.0.1',          // IPv4-compatible loopback in v6 space
		'::ffff:7f00:1',       // IPv4-mapped, hex-spelled by a URL parser
		'::ffff:a00:1',        // IPv4-mapped 10.0.0.1, hex-spelled
		'0.1.2.3',            // 0.0.0.0/8 "this network"
		'192.0.0.1', '192.0.2.1',
		'192.88.99.1',         // 6to4 relay anycast
		'198.51.100.1', '203.0.113.1', // TEST-NET-2/3
		'224.0.0.1', '239.255.255.255', // multicast
		'240.0.0.1', '255.255.255.255', // reserved + broadcast
		'2001::1',             // Teredo
		'100::1',              // discard-only
		'2001:db8::1'          // documentation
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
		'http://100.64.0.1:9/v1', // CGNAT
		'http://[fd00::1]:9/v1',
		'http://192.168.1.1/v1',
		'http://localhost:9/v1',
		'http://metadata.google.internal/v1',
		'http://2130706433/v1', // decimal-encoded 127.0.0.1
		'http://0x7f000001/v1', // hex-encoded 127.0.0.1
		// Encapsulated metadata: the address in the URL is the one the
		// socket dials, so these must be refused before any DNS work.
		'http://[64:ff9b::a9fe:a9fe]/v1',
		'http://[2002:7f00:1::]/v1'
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
