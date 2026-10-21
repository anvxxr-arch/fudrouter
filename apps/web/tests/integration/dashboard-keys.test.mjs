// tests/integration/dashboard-keys.test.mjs — the /dashboard/keys payload shape.
//
// Why this file exists: GET /api/pages/dashboard/keys was registered TWICE —
// an inline handler in index.mjs that selected only the raw api_key columns,
// and the complete one in pages.mjs that adds usage30d, projectName and
// expiresAt. Express serves the first registered match, and index.mjs's inline
// route is registered before registerPages(), so the incomplete one won.
//
// The page then crashed on every load: KeysPage renders
// `b.usage30d.requests` while sorting and `k.projectName` while rendering, and
// neither key existed in the shadowing response. The server never logged a 500
// — it answered 200 with a valid-but-wrong shape — so no error appeared in the
// console log and the failure looked client-side.
//
// This test pins the shape the client actually dereferences, which is the only
// thing that would have caught the shadowed handler: a 200 alone would not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const NEEDS_DB = { skip: !hasDb && SKIP };

let server;
let cookie;

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	const user = await signUp(server.baseUrl, { email: uniqueEmail('keys') });
	assert.equal(user.status, 200, `sign-up failed: ${JSON.stringify(user.body)}`);
	cookie = user.cookie;
});

test.after(async () => {
	await server?.stop();
});

test('/api/pages/dashboard/keys returns fields the page dereferences', NEEDS_DB, async () => {
	const res = await fetch(`${server.baseUrl}/api/pages/dashboard/keys`, { headers: { cookie } });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok(Array.isArray(body.keys), 'keys must be an array');

	// A fresh account has no keys, so create one through the real endpoint —
	// the shape assertions below need a row to inspect.
	const created = await fetch(`${server.baseUrl}/api/pages/dashboard/keys/create`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'shape-check' })
	});
	assert.equal(created.status, 200, `create failed: ${await created.text()}`);

	const after = await fetch(`${server.baseUrl}/api/pages/dashboard/keys`, { headers: { cookie } });
	assert.equal(after.status, 200);
	const { keys } = await after.json();
	assert.equal(keys.length, 1, 'the created key must be listed');

	const k = keys[0];
	// Every one of these is read unconditionally by KeysPage. usage30d is the
	// one that actually crashed, because the sort dereferences it for every row.
	assert.deepEqual(
		Object.keys(k.usage30d).sort(),
		['costMicro', 'requests', 'tokens'],
		'usage30d must carry the exact counters the page reads'
	);
	assert.equal(k.usage30d.requests, 0, 'a new key has no usage yet');
	for (const field of ['id', 'name', 'prefix', 'status', 'createdAt', 'projectId', 'projectName', 'environmentName', 'expiresAt', 'revokedAt', 'lastUsedAt']) {
		assert.ok(field in k, `keys[0].${field} is missing — the page reads it`);
	}
});
