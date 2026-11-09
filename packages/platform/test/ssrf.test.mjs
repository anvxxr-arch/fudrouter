// Unit tests for the SSRF guard's dial-time pinning (hack/netsec).
//
// `guardedUpstreamFetch` closes the DNS-rebind window by pinning the validated
// addresses into a per-call undici Agent whose connector lookup returns ONLY
// `assertPublicUpstream`'s approved `ips`. `pinLookup` is the closure that
// makes the socket resolve to exactly those addresses; it is pure and testable
// without any network or DNS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinLookup, parseV6, assertPublicUpstream } from '@fudrouter/platform/server/ssrf.ts';

function resolve(lookup, name, family = 0) {
  return new Promise((ok, err) => {
    lookup(name, { family }, (e, addrs) => (e ? err(e) : ok(addrs)));
  });
}

test('pinLookup resolves the approved host to exactly the validated addresses', async () => {
  const ips = ['93.184.216.34', '2606:4700::1111'];
  const lookup = pinLookup('example.com', ips);
  const addrs = await resolve(lookup, 'example.com');
  assert.deepEqual(
    addrs.map((a) => a.address),
    ips
  );
  const families = new Set(addrs.map((a) => a.family));
  assert.ok(families.has(4), 'IPv4 address carries family 4');
  assert.ok(families.has(6), 'IPv6 address carries family 6');
});

test('pinLookup is case-insensitive on the approved hostname', async () => {
  const lookup = pinLookup('Example.COM', ['1.1.1.1']);
  const addrs = await resolve(lookup, 'example.com');
  assert.equal(addrs[0].address, '1.1.1.1');
});

test('pinLookup fails closed for any hostname other than the approved one', async () => {
  const lookup = pinLookup('example.com', ['1.1.1.1']);
  await assert.rejects(() => resolve(lookup, '169.254.169.254'), /unvalidated host/);
  await assert.rejects(() => resolve(lookup, 'evil.example.com'), /unvalidated host/);
});

test('pinLookup fails closed on an empty validated set', async () => {
  const lookup = pinLookup('example.com', []);
  await assert.rejects(() => resolve(lookup, 'example.com'), /unvalidated host/);
});

test('parseV6 still parses the mapped/compatible forms the blocklist depends on', () => {
  assert.equal(parseV6('::ffff:7f00:1'), 0x00000000000000000000ffff7f000001n);
  assert.equal(parseV6('::7f00:1'), 0x7f000001n);
});

test('a public LITERAL is accepted without a DNS round and yields that literal', async () => {
  // The literal is the address the socket dials, so it is both the checked and
  // the dialled target: no resolver, no rebind window.
  const r = await assertPublicUpstream('http://93.184.216.34/v1', false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ips, ['93.184.216.34']);
});

test('a public IPv6 LITERAL is accepted (its bracketed form is not a DNS name)', async () => {
  const r = await assertPublicUpstream('http://[2606:4700::1111]/v1', false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ips, ['2606:4700::1111']);
});

test('a private LITERAL is still refused before any resolution', async () => {
  for (const u of ['http://127.0.0.1/v1', 'http://[::1]/v1', 'http://[::ffff:127.0.0.1]/v1']) {
    const r = await assertPublicUpstream(u, false);
    assert.equal(r.ok, false, `expected ${u} refused`);
  }
});
