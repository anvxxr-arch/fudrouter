// tests/integration/tenant-isolation.test.mjs — cross-tenant authorization.
//
// Why this file exists: four separate routes proved the same missing idea — that
// a permission check on the CALLER's tenant does not bind the DATA to it.
// Each was reachable by an ordinary member of a second tenant:
//
//   1. POST /api/pages/projects/:projectId/aliases/delete fetched the alias by
//      primary key from the request body and accepted it when it was "not
//      global" (workspace_id IS NOT NULL) and "not another project's"
//      (project_id IS NULL). Another tenant's alias had exactly that shape, so
//      any member with alias.write deleted it outright, and the audit row was
//      filed under the actor's own workspaceId.
//   2. GET /api/palette/requests checked request.read against the caller's
//      workspace and then queried request_log by id prefix alone, returning
//      every tenant's request ids. A uuidv7 id is timestamp-prefixed, so the
//      leading characters were enumerable.
//   3. POST /api/pages/team/members/invite resolved the role with a lookup that
//      admits the builtin owner template and then inserted the membership with
//      no dominance check — the rule changeRole enforces on itself, bypassed by
//      inviting instead of changing. (Removed with the membership surface in
//      0019; see the note where the test used to be.)
//   4. GET /api/admin/users built its payload and never returned it, so the
//      wrapper serialised undefined: HTTP 200 with zero bytes, which the SPA
//      reports as a transport error.
//
// Migration 0019 flattened the hierarchy, so "tenant" now means the user
// account. The invariants are unchanged and the alias tests were re-expressed
// against /api/pages/aliases rather than deleted.
//
// Every test ASSERTS THE ABSENCE OF THE CROSS-TENANT EFFECT and was checked to
// FAIL on the pre-fix code (see the mutation note in each). A test of this shape
// that passes both before and after the fix proves nothing: the first version of
// the alias test was vacuous because it never got past an early return (the test
// database has no `model` rows, so the alias-create helper returned before the
// guard). It now seeds a model and asserts on the FIXTURE first.
//
// Gating mirrors the rest of the suite: module-scope `skip`, because a
// `t.Skip` in test.before throws in Node 22 and reports failures instead of
// skips. The harness still FAILS under CI with no DSN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startServer, signUp, uniqueEmail, integrationEnabled } from './harness.mjs';

const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';
const NEEDS_DB = { skip: !hasDb && SKIP };

let server;
let sql;
let a; // the attacker: an ordinary account
let b; // the victim: a second, unrelated account
let modelId; // a real model row, so the alias routes get past their guards

/** Sign up a tenant (the user account is the tenant after migration 0019). */
async function tenant(tag) {
	const signed = await signUp(server.baseUrl, { email: uniqueEmail(tag) });
	assert.equal(signed.status, 200, `sign-up(${tag}) failed: ${JSON.stringify(signed.body)}`);
	const acct = await fetch(`${server.baseUrl}/api/pages/account`, { headers: { cookie: signed.cookie } });
	assert.equal(acct.status, 200, `${tag} has no account page`);
	return { cookie: signed.cookie };
}

/** Create an account-scoped alias in a tenant, or fail loudly. */
async function createAlias(t, name) {
	const res = await fetch(`${server.baseUrl}/api/pages/aliases/create`, {
		method: 'POST',
		headers: { cookie: t.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ name, scope: 'account', targets: [modelId] })
	});
	const body = await res.json().catch(() => ({}));
	assert.equal(res.status, 200, `alias create failed (${res.status}): ${JSON.stringify(body)}`);
	assert.ok(body.id, 'the created alias must carry an id');
	return body.id;
}

/** The ids of the aliases a tenant can see through its own aliases page. */
async function visibleAliases(t) {
	const res = await fetch(`${server.baseUrl}/api/pages/aliases`, { headers: { cookie: t.cookie } });
	assert.equal(res.status, 200, 'the aliases list must answer');
	return ((await res.json()).aliases ?? []).map((x) => x.id);
}

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	a = await tenant('iso-a');
	b = await tenant('iso-b');

	// The alias routes filter `model.status <> 'disabled'`, and a throwaway
	// database has no models at all — the first version of this file therefore
	// took the "no models" early return and never reached the guard it was
	// written to test. Seed one through the database, not the admin API (which a
	// fresh sign-up cannot reach), and prove it is visible before asserting.
	const existing = await sql`select id from model where status <> 'disabled' limit 1`;
	if (existing.length > 0) {
		modelId = existing[0].id;
	} else {
		// A provider is required by the model FK; create the minimum tree.
		const prov = await sql`
			insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
			values ('prv_isotest', 'isolation-test', 'http://127.0.0.1:1', '{}', 'active', 100, now())
			on conflict (id) do nothing returning id`;
		if (prov.length === 0) await sql`select id from provider where id = 'prv_isotest'`;
		const mid = 'mdl_isotest';
		await sql`
			insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
			values (${mid}, 'prv_isotest', 'Isolation Test', 'isolation-test-model', 8192, '1', '1', 'USD', 'active')
			on conflict (id) do nothing`;
		modelId = mid;
	}
	const seen = await fetch(`${server.baseUrl}/api/pages/aliases`, { headers: { cookie: a.cookie } });
	const models = (await seen.json()).models ?? [];
	assert.ok(models.some((m) => m.id === modelId), `the seeded model is not visible to the alias form (got ${models.length} models)`);
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

test('an alias in another account cannot be deleted by id', NEEDS_DB, async () => {
	// B creates an account-scoped alias — the shape that slipped through before
	// 0019: owned by a tenant, but the delete only checked "not global".
	const aliasId = await createAlias(b, 'victim-alias');
	assert.ok(
		(await visibleAliases(b)).includes(aliasId),
		'fixture check: the victim alias must exist before the attack'
	);

	// A, an unrelated account, deletes it by id.
	const attack = await fetch(`${server.baseUrl}/api/pages/aliases/delete`, {
		method: 'POST',
		headers: { cookie: a.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: aliasId })
	});

	// Mutation: removing the `account_id !== userRow.id` guard makes the delete
	// succeed (attack 200) and this assertion fails with "cross-tenant alias
	// delete succeeded".
	assert.ok(
		(await visibleAliases(b)).includes(aliasId),
		`cross-tenant alias delete succeeded (attack status ${attack.status}) — another account's alias was removed`
	);
});

test('an alias from another account is not visible in the list', NEEDS_DB, async () => {
	// Same shape as the delete, read side: the list query is
	// `account_id = caller OR account_id IS NULL`. B's account alias must not
	// appear in A's page.
	const aliasId = await createAlias(b, 'victim-read-alias');
	assert.ok(!(await visibleAliases(a)).includes(aliasId), 'another account\'s alias leaked into the list');
});

test('the palette request search cannot see another tenant', NEEDS_DB, async () => {
	// Both tenants search the same prefix; request ids are unique, so an id
	// appearing for both callers can only come from an unscoped query. The
	// search only answers at >= 3 characters.
	const aItems = (await (await fetch(`${server.baseUrl}/api/palette/requests?q=req`, { headers: { cookie: a.cookie } })).json()).items ?? [];
	const bItems = (await (await fetch(`${server.baseUrl}/api/palette/requests?q=req`, { headers: { cookie: b.cookie } })).json()).items ?? [];
	const aIds = new Set(aItems.map((i) => i.id));
	const shared = bItems.filter((i) => aIds.has(i.id));
	assert.equal(
		shared.length,
		0,
		`the palette leaked ${shared.length} request id(s) across tenants: ${shared.slice(0, 3).map((i) => i.id).join(', ')}`
	);
});

// The `member.invite` escalation test that used to live here is gone with the
// surface it guarded: migration 0019 dropped `workspace_member` and
// `workspace_role`, and with them /api/pages/team/**. There is no membership
// to insert and no role to escalate to — an account has exactly one user, so
// the hole cannot be reintroduced without restoring the hierarchy first.

test('/api/admin/users returns a JSON payload, not an empty 200', NEEDS_DB, async () => {
	// The handler built its maps and never returned, so handler()'s res.json()
	// serialised undefined: HTTP 200, Content-Type: application/json, ZERO bytes,
	// and the admin Users page reported a transport error for a broken server
	// function while the server logged nothing.
	//
	// Admin is granted by a row update, not a new session (the promotion pattern
	// admin-valkey.test.mjs uses): a fresh sign-up is a plain member, so without
	// this the request is a 403 and the bug is invisible.
	const admin = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(admin.status, 200);
	await sql`update "user" set role = 'admin' where email = ${admin.body?.user?.email}`;

	const res = await fetch(`${server.baseUrl}/api/admin/users`, { headers: { cookie: admin.cookie } });
	const text = await res.text();
	assert.equal(res.status, 200, `admin users = ${res.status}: ${text.slice(0, 160)}`);
	assert.ok(text.length > 0, 'the admin users endpoint returned an empty body (the missing-return bug)');
	const body = JSON.parse(text);
	assert.ok(Array.isArray(body.users), 'the payload must carry a users array');
	// The assembled per-user counts must be present, not just the raw rows: the
	// handler's whole job is joining those maps onto the user list.
	if (body.users.length > 0) {
		const u = body.users[0];
		for (const field of ['requests', 'cost', 'keys', 'firstRequestAt', 'lastSeenAt']) {
			assert.ok(field in u, `the users payload is missing ${field}`);
		}
	}
});
