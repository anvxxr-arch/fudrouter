// Unit tests for the SSRF IP classification + real client-IP extraction.
// The classification itself lives in packages/platform/server/ssrf.ts and is
// re-exported by ip.mjs, so this suite is the regression net for the rule the
// live guard uses, not for a console-local copy of it.
//
// These two helpers are the only thing standing between a user-supplied
// `base_url` / `X-Forwarded-For` and the loopback network, so the cases below
// are the regression net for the exact gaps the audit found (CGNAT, TEST-NET,
// benchmarking, multicast/reserved, IPv4-mapped IPv6) and for the leftmost-hop
// spoofing bug. Run with `node --test` (no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isBlockedIp,
	_parseV6,
	_ipv4ToBig,
	_ipv4BlockedBig,
	_ipv6BlockedBig,
	clientIp,
	isTrustedProxy,
	_normalizeIp
} from './ip.mjs';

test('isBlockedIp blocks every IANA special-use range', () => {
	const blocked = [
		'127.0.0.1', '127.255.255.255', // loopback
		'10.0.0.1', '10.255.255.255', // RFC1918
		'172.16.0.1', '172.31.255.255', // RFC1918
		'192.168.1.1', // RFC1918
		'100.64.0.1', '100.127.255.255', // CGNAT — the old blocklist missed this
		'169.254.169.254', '169.254.0.1', // link-local + cloud metadata
		'192.0.0.1', '192.0.2.1', // 192.0.0/24 + TEST-NET-1
		'192.88.99.1', // 6to4 relay anycast
		'198.18.0.1', '198.19.255.255', // benchmarking
		'198.51.100.1', // TEST-NET-2
		'203.0.113.1', // TEST-NET-3
		'224.0.0.1', '239.255.255.255', // multicast
		'240.0.0.1', '255.255.255.255', // reserved + broadcast
		'0.0.0.0', '0.1.2.3', // "this network"
		'::1', '::', // v6 loopback / unspecified
		'fc00::1', 'fd00::1', // unique-local
		'fe80::1', // link-local
		'ff02::1', // multicast
		'2001:db8::1', // documentation
		'2001::1', // Teredo
		'2002::1', // 6to4
		'64:ff9b::7f00:1', // NAT64
		'100::1', // discard-only
		'::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '::ffff:100.64.0.1', // IPv4-mapped
		'::ffff:7f00:1', '::ffff:a00:1', // IPv4-mapped, hex-spelled by a URL parser
		'::0.0.0.1', // IPv4-compatible loopback in v6 space
		'64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', // NAT64 of metadata / RFC1918
		'2002:7f00:1::', '2002:c0a8:101::' // 6to4 of loopback / RFC1918
	];
	for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `expected ${ip} blocked`);
});

test('isBlockedIp allows public addresses', () => {
	for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '104.16.0.1', '203.0.114.1', '2606:4700::1111', '2a00:1450::1']) {
		assert.equal(isBlockedIp(ip), false, `expected ${ip} allowed`);
	}
});

test('isBlockedIp treats empty/garbage as blocked (fail closed)', () => {
	for (const v of ['', null, undefined, 'not-an-ip']) {
		// 'not-an-ip' is a hostname, not a literal -> false (DNS check covers it)
		const expected = v === 'not-an-ip' ? false : true;
		assert.equal(isBlockedIp(v), expected, `isBlockedIp(${JSON.stringify(v)})`);
	}
});

test('_parseV6 parses and rejects malformed input', () => {
	assert.equal(_parseV6('::1'), 1n);
	assert.equal(_parseV6('::'), 0n);
	assert.equal(_parseV6('1:2:3:4:5:6:7:8'), 0x00010002000300040005000600070008n);
	assert.equal(_parseV6('::ffff:1.2.3.4'), 0x00000000000000000000ffff01020304n);
	assert.equal(_parseV6('[::1]'), 1n);
	assert.equal(_parseV6('fe80::1%eth0'), 0xfe800000000000000000000000000001n);
	assert.equal(_parseV6('1:2:3:4:5:6:7:8:9'), null);
	assert.equal(_parseV6('::ffff:1.2.3.999'), null);
});

test('_ipv4ToBig / _ipv4BlockedBig boundaries', () => {
	assert.equal(_ipv4ToBig('255.255.255.255'), 0xffffffffn);
	assert.equal(_ipv4ToBig('1.2.3'), null);
	assert.equal(_ipv4ToBig('1.2.3.256'), null);
	assert.equal(_ipv4BlockedBig(_ipv4ToBig('100.63.255.255')), false, 'just below CGNAT');
	assert.equal(_ipv4BlockedBig(_ipv4ToBig('100.64.0.0')), true, 'CGNAT start');
	assert.equal(_ipv4BlockedBig(_ipv4ToBig('100.128.0.0')), false, 'just above CGNAT');
	assert.equal(_ipv4BlockedBig(_ipv4ToBig('172.15.255.255')), false);
	assert.equal(_ipv4BlockedBig(_ipv4ToBig('172.32.0.0')), false);
});

test('_ipv6BlockedBig boundaries', () => {
	assert.equal(_ipv6BlockedBig(_parseV6('fe7f::1')), false, 'just below link-local');
	assert.equal(_ipv6BlockedBig(_parseV6('fe80::1')), true);
	assert.equal(_ipv6BlockedBig(_parseV6('fbff::1')), false, 'just below unique-local');
	assert.equal(_ipv6BlockedBig(_parseV6('fc00::1')), true);
});

test('clientIp walks X-Forwarded-For right-to-left past trusted proxies', () => {
	const req = (sock, xff) => ({
		socket: { remoteAddress: sock },
		headers: xff === undefined ? {} : { 'x-forwarded-for': xff }
	});
	// single hop
	assert.equal(clientIp(req('127.0.0.1', '1.2.3.4')), '1.2.3.4');
	// rightmost untrusted wins
	assert.equal(clientIp(req('127.0.0.1', '1.2.3.4, 5.6.7.8')), '5.6.7.8');
	// a spoofed LEFT hop is ignored: the trusted loopback hop appended by caddy
	// is skipped and the real client (5.6.7.8) is returned, not 9.9.9.9.
	assert.equal(clientIp(req('127.0.0.1', '9.9.9.9, 5.6.7.8, 127.0.0.1')), '5.6.7.8');
	// no header -> socket peer
	assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
	// untrusted peer: the header is ignored entirely (direct/LAN caller)
	assert.equal(clientIp(req('203.0.113.9', '1.2.3.4')), '203.0.113.9');
	// IPv4-mapped loopback peer is still a trusted proxy
	assert.equal(clientIp(req('::ffff:127.0.0.1', '1.2.3.4')), '1.2.3.4');
	// public IPv6 peer is not trusted
	assert.equal(clientIp(req('2001:db8::5', '1.2.3.4')), '2001:db8::5');
	// all hops trusted -> fall back to the socket peer
	assert.equal(clientIp(req('127.0.0.1', '127.0.0.1, ::1')), '127.0.0.1');
});

test('_normalizeIp and isTrustedProxy', () => {
	assert.equal(_normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
	assert.equal(_normalizeIp('[::1]'), '::1');
	assert.equal(_normalizeIp('fe80::1%eth0'), 'fe80::1');
	assert.equal(_normalizeIp(''), null);
	assert.equal(isTrustedProxy('127.0.0.1'), true);
	assert.equal(isTrustedProxy('::1'), true);
	assert.equal(isTrustedProxy('::ffff:127.0.0.1'), true);
	assert.equal(isTrustedProxy('192.168.1.5'), false);
	assert.equal(isTrustedProxy('8.8.8.8'), false);
});
