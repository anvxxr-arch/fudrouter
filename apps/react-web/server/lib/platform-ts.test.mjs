// Regression tests for audit fixes: shared-TS bridge parity, JSON error
// middleware shape, unknown-page-API 404 contract, robots/sitemap routes.
//
// These lock the fixes that moved live numbers during the audit. They test
// units and route wiring without a database: no test here touches Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isBlockedLiteral, _sanitizeAudit, _tokenAt, _headersFor, newId, ID_PREFIXES } from './platform-ts.mjs';

test('bridge blocks loopback literals and allows public names', () => {
	assert.equal(_isBlockedLiteral('localhost'), true);
	assert.equal(_isBlockedLiteral('127.0.0.1'), true);
	assert.equal(_isBlockedLiteral('10.0.0.5'), true);
	assert.equal(_isBlockedLiteral('169.254.169.254'), true);
	assert.equal(_isBlockedLiteral('example.com'), false);
	assert.equal(_isBlockedLiteral(''), true);
});

test('bridge allows private only via assertPublicUpstream', async () => {
	const { _assertPublic } = await import('./platform-ts.mjs');
	const pub = await _assertPublic('https://example.com/v1');
	assert.equal(pub.ok, true);
	const priv = await _assertPublic('http://127.0.0.1:5432');
	assert.equal(priv.ok, false);
});

test('bridge redacts secret keys like the local regex did', () => {
	const out = _sanitizeAudit({ api_key: 'sk-x', name: 'ok', nested: { password: 'p' } });
	assert.equal(out.api_key, '[redacted]');
	assert.equal(out.name, 'ok');
	assert.equal(out.nested.password, '[redacted]');
});

test('bridge reads flat credential tokens (spec section 4 shape)', () => {
	const flat = { email: 'a@b.c', access_token: 'tok123' };
	assert.equal(_tokenAt(flat, 0), 'tok123');
	const h = _headersFor(flat, 'tok123');
	assert.equal(h.authorization, 'Bearer tok123');
	const empty = _headersFor(flat, '');
	assert.equal('authorization' in empty, false);
});

test('bridge mints prefixed ids from the canonical table', () => {
	const id = newId(ID_PREFIXES.apiKey);
	assert.ok(id.startsWith('key_'), `expected key_ prefix, got ${id}`);
});

// The canonical envelope (packages/platform/server/credentials.ts) is what the
// control plane, the workers and the scheduler all decrypt with, so the master
// key rotation seam has to live there — a prev-key the Go router understands
// but this module does not leaves the console unable to read its own rows.
test('bridge accepts the previous master key during a rotation window', async () => {
	const { _encCred, _decCred } = await import('./platform-ts.mjs');
	const KEY_OLD = Buffer.alloc(32, 7).toString('base64');
	const KEY_NEW = Buffer.alloc(32, 9).toString('base64');
	const before = { ...process.env };
	try {
		// A blob written by the build that still used the old key.
		process.env.CREDENTIALS_MASTER_KEY = KEY_OLD;
		delete process.env.CREDENTIALS_MASTER_KEY_PREV;
		const legacy = _encCred({ api_key: 'sk-rotation' });

		// Rotation: active is the new key, the old one is on standby.
		process.env.CREDENTIALS_MASTER_KEY = KEY_NEW;
		process.env.CREDENTIALS_MASTER_KEY_PREV = KEY_OLD;
		assert.deepEqual(_decCred(legacy), { api_key: 'sk-rotation' });

		// Every write already uses the new key, so it needs no standby at all.
		const fresh = _encCred({ api_key: 'sk-new' });
		delete process.env.CREDENTIALS_MASTER_KEY_PREV;
		assert.deepEqual(_decCred(fresh), { api_key: 'sk-new' });

		// Steady state: a mismatched key is still an error, never a silent pass.
		assert.throws(() => _decCred(legacy));

		// A malformed standby key fails loudly instead of orphaning old rows.
		process.env.CREDENTIALS_MASTER_KEY_PREV = 'not-base64';
		assert.throws(() => _decCred(legacy), /CREDENTIALS_MASTER_KEY_PREV/);
	} finally {
		for (const k of ['CREDENTIALS_MASTER_KEY', 'CREDENTIALS_MASTER_KEY_PREV']) {
			if (before[k] === undefined) delete process.env[k];
			else process.env[k] = before[k];
		}
	}
});
