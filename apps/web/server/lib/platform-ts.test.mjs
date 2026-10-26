// Regression tests for the shared-TS bridge: credential parity with
// packages/platform, the loopback/IP guard, audit redaction, id minting, and the
// master-key rotation window.
//
// These lock the fixes that moved live numbers during the audit. They test units
// without a database: no test here touches Postgres.
//
// NOT covered here, despite an earlier version of this header saying so: the
// capability/RBAC table (that is server/lib/rbac.test.mjs), the JSON-error
// middleware, the unknown-page-API 404 contract, and the robots/sitemap routes.
// The latter three live in index.mjs, which binds a port at import time, so they
// need a subprocess harness — not this unit file. Stated as what is known: they
// are absent here; I did not verify they are asserted elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isBlockedLiteral, _sanitizeAudit, _tokenAt, _headersFor, newId, ID_PREFIXES, reachability, served, allowDevProviders } from './platform-ts.mjs';

test('bridge blocks loopback literals and allows public names', () => {
	assert.equal(_isBlockedLiteral('localhost'), true);
	assert.equal(_isBlockedLiteral('127.0.0.1'), true);
	assert.equal(_isBlockedLiteral('10.0.0.5'), true);
	assert.equal(_isBlockedLiteral('169.254.169.254'), true);
	assert.equal(_isBlockedLiteral('example.com'), false);
	assert.equal(_isBlockedLiteral(''), true);
});

test('bridge exposes the shared publish gate', () => {
	// The console used to carry TWO hand copies of this rule (admin.mjs's
	// `_reach` and public.mjs's `served`), which is the drift publish.ts's header
	// warns about — an earlier audit found the copies disagreeing with the shared
	// list. This pins the bridge's version so a future local copy has something
	// to fail against.
	const ok = { status: 'active', enabled: true, tier: 'commercial' };
	assert.deepEqual(reachability('active', ok, false), { served: true, reason: null });
	assert.deepEqual(reachability('active', { ...ok, status: 'dev' }, false), { served: false, reason: 'provider-off' });
	assert.deepEqual(reachability('active', { ...ok, status: 'dev' }, true), { served: true, reason: null });
	assert.deepEqual(reachability('draft', ok, true), { served: false, reason: 'unpublished' });
	assert.equal(served('draft', ok, true), false);
	assert.equal(served('active', ok, false), true);
	// The env read must agree with the rule's own parser: a truthy spelling the
	// router accepts but the console rejected would be a two-plane disagreement.
	const before = process.env.ROUTER_ALLOW_DEV_PROVIDERS;
	try {
		for (const on of ['1', 'true', 'yes', 'on', 'TRUE']) {
			process.env.ROUTER_ALLOW_DEV_PROVIDERS = on;
			assert.equal(allowDevProviders(), true, `${on} must enable dev providers`);
		}
		for (const off of ['', '0', 'no', 'off', 'false', 'maybe']) {
			process.env.ROUTER_ALLOW_DEV_PROVIDERS = off;
			assert.equal(allowDevProviders(), false, `${off} must not enable dev providers`);
		}
	} finally {
		if (before === undefined) delete process.env.ROUTER_ALLOW_DEV_PROVIDERS;
		else process.env.ROUTER_ALLOW_DEV_PROVIDERS = before;
	}
});

// A source-level scan, because the behavioural test above cannot catch this: a
// re-introduced local copy of the publish gate behaves identically until the day
// it drifts, and then the console and the router disagree about which models are
// servable. The scan looks for the rule's SHAPE in the server files that must
// not carry it — `modelStatus !== 'active'` paired with a `providerStatus`
// branch — rather than for a variable name, so renaming the copy does not evade
// it.
test('no hand copy of the publish gate survives in the server', async () => {
	const { readFileSync, readdirSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { fileURLToPath } = await import('node:url');
	const { dirname } = await import('node:path');
	const here = dirname(fileURLToPath(import.meta.url));
	const serverDir = join(here, '..');
	const files = readdirSync(serverDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
	const offenders = [];
	for (const f of files) {
		const src = readFileSync(join(serverDir, f), 'utf8');
		// The rule in one place: a model-status check AND any comparison against a
		// provider status. The first version of this scan only looked for a `'dev'`
		// branch, and a copy that returned early on `providerStatus === 'active'`
		// slipped through — so the pattern matches the status comparison itself,
		// not one particular status value.
		const hasModelCheck = /modelStatus\s*[!=]==?\s*'active'/.test(src);
		const hasProviderBranch = /providerStatus\s*[!=]==?/.test(src);
		if (hasModelCheck && hasProviderBranch) offenders.push(f);
	}
	assert.deepEqual(offenders, [], `hand copy of the publish gate in: ${offenders.join(', ')}`);
});

test('bridge allows private only via assertPublicUpstream', async () => {
	const { _assertPublic } = await import('./platform-ts.mjs');
	const pub = await _assertPublic('https://example.com/v1');
	assert.equal(pub.ok, true);
	const priv = await _assertPublic('http://127.0.0.1:5432');
	assert.equal(priv.ok, false);
});

test('a base_url may not embed credentials', async () => {
	// Why: assertPublicUpstream checks scheme, literal and DNS, but never
	// url.username/url.password — so `https://user:pass@host/v1` was ACCEPTED by
	// the connection create/update path, persisted to connection.base_url and
	// echoed back through the providers API. admin-limits.ts states this rule for
	// its own inputs ("puts a secret in every log line and error message"); it
	// was simply not applied to the URL that reaches the database.
	const { _assertPublic } = await import('./platform-ts.mjs');
	const result = await _assertPublic('https://user:s3cret@example.com/v1');
	assert.equal(result.ok, false, 'a credential-bearing base_url must be refused');
	// The secret must not come back in the reason either — the reason is shown to
	// the admin and written to the audit log.
	assert.ok(
		!String(result.reason).includes('s3cret'),
		`the refusal leaked the secret: ${result.reason}`,
	);
	// A user (no password) and a password (no user) are both credentials.
	assert.equal((await _assertPublic('https://user@example.com/v1')).ok, false);
	assert.equal((await _assertPublic('https://:s3cret@example.com/v1')).ok, false);
	// A URL with no credentials is unaffected.
	assert.equal((await _assertPublic('https://example.com/v1')).ok, true);
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
