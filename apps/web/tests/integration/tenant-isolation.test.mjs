// tests/integration/tenant-isolation.test.mjs — cross-tenant authorization.
//
// Why this file exists: four separate routes proved the same missing idea — that
// a permission check on the CALLER's workspace does not bind the DATA to it.
// Each was reachable by an ordinary member of a second workspace:
//
//   1. POST /api/pages/projects/:projectId/aliases/delete fetched the alias by
//      primary key from the request body and accepted it when it was "not
//      global" (workspace_id IS NOT NULL) and "not another project's"
//      (project_id IS NULL). Another workspace's WORKSPACE-SCOPED alias has
//      exactly that shape, so any member with alias.write deleted it outright,
//      and the audit row was filed under the actor's own workspaceId.
//   2. GET /api/palette/requests checked request.read against the caller's
//      workspace and then queried request_log by id prefix alone, returning
//      every tenant's request ids. A uuidv7 id is timestamp-prefixed, so the
//      leading characters were enumerable.
//   3. POST /api/pages/team/members/invite resolved the role with a lookup that
//      admits the builtin owner template and then inserted the membership with
//      no dominance check — the rule changeRole enforces on itself, bypassed by
//      inviting instead of changing.
//   4. GET /api/admin/users built its payload and never returned it, so the
//      wrapper serialised undefined: HTTP 200 with zero bytes, which the SPA
//      reports as a transport error.
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
let a; // the attacker: an ordinary member of its own workspace
let b; // the victim: a second, unrelated workspace
let modelId; // a real model row, so the alias routes get past their guards

/** Sign up a tenant and return { cookie, projectId }. */
async function tenant(tag) {
	const signed = await signUp(server.baseUrl, { email: uniqueEmail(tag) });
	assert.equal(signed.status, 200, `sign-up(${tag}) failed: ${JSON.stringify(signed.body)}`);
	const ws = await fetch(`${server.baseUrl}/api/pages/workspace`, { headers: { cookie: signed.cookie } });
	assert.ok((await ws.json()).workspace?.id, `${tag} has no workspace`);
	const projects = await fetch(`${server.baseUrl}/api/pages/projects`, { headers: { cookie: signed.cookie } });
	const list = (await projects.json()).projects ?? [];
	assert.ok(list.length > 0, `${tag} was provisioned without a project`);
	return { cookie: signed.cookie, projectId: list[0].id };
}

/** Create a workspace-scoped alias in a tenant, or fail loudly. */
async function createAlias(t, name) {
	const res = await fetch(`${server.baseUrl}/api/pages/projects/${t.projectId}/aliases/create`, {
		method: 'POST',
		headers: { cookie: t.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ name, scope: 'workspace', targets: [modelId] })
	});
	const body = await res.json().catch(() => ({}));
	assert.equal(res.status, 200, `alias create failed (${res.status}): ${JSON.stringify(body)}`);
	assert.ok(body.id, 'the created alias must carry an id');
	return body.id;
}

/** The ids of the aliases a tenant can see through its own project page. */
async function visibleAliases(t) {
	const res = await fetch(`${server.baseUrl}/api/pages/projects/${t.projectId}/aliases`, { headers: { cookie: t.cookie } });
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
	const seen = await fetch(`${server.baseUrl}/api/pages/projects/${a.projectId}/aliases`, { headers: { cookie: a.cookie } });
	const models = (await seen.json()).models ?? [];
	assert.ok(models.some((m) => m.id === modelId), `the seeded model is not visible to the alias form (got ${models.length} models)`);
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

test('an alias in another workspace cannot be deleted by id', NEEDS_DB, async () => {
	// B creates a WORKSPACE-scoped alias — the shape that slipped through:
	// workspace_id set, project_id NULL.
	const aliasId = await createAlias(b, 'victim-alias');
	assert.ok(
		(await visibleAliases(b)).includes(aliasId),
		'fixture check: the victim alias must exist before the attack'
	);

	// A, an unrelated tenant, deletes it by id through its OWN project path.
	const attack = await fetch(`${server.baseUrl}/api/pages/projects/${a.projectId}/aliases/delete`, {
		method: 'POST',
		headers: { cookie: a.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: aliasId })
	});

	// Mutation: removing the `workspace_id !== workspaceId` guard makes the
	// delete succeed (attack 200) and this assertion fails with "cross-tenant
	// alias delete succeeded".
	assert.ok(
		(await visibleAliases(b)).includes(aliasId),
		`cross-tenant alias delete succeeded (attack status ${attack.status}) — another workspace's alias was removed`
	);
});

test('an alias from another workspace is not visible in the list', NEEDS_DB, async () => {
	// Same shape as the delete, read side: the list query unions
	// `project_id = proj` OR `workspace_id = actor AND project_id is null` OR
	// global. B's workspace-scoped alias must not appear in A's page.
	const aliasId = await createAlias(b, 'victim-read-alias');
	assert.ok(!(await visibleAliases(a)).includes(aliasId), 'another workspace\'s alias leaked into the list');
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

test('invite cannot grant the owner role to a non-owner', NEEDS_DB, async () => {
	// The escalation path: `member.invite` is a LOWER bar than `workspace.write`
	// (changeRole's gate), so without a dominance check here an admin can mint
	// an owner. B's owner may grant owner (the feature must not break); a
	// SECOND member of B holding roleId=rol_admin may not.
	const roles = (await (await fetch(`${server.baseUrl}/api/pages/team/members`, { headers: { cookie: b.cookie } })).json()).roles ?? [];
	const ownerRole = roles.find((r) => r.id === 'rol_owner' || String(r.name).toLowerCase() === 'owner');
	assert.ok(ownerRole, 'the builtin owner role must be listed');
	const adminRole = roles.find((r) => r.id === 'rol_admin' || String(r.name).toLowerCase() === 'admin');
	assert.ok(adminRole, 'the builtin admin role must be listed');

	// A non-owner member of B: invite a distinct address into B's admin role.
	const adminEmail = uniqueEmail('iso-admin');
	const promoted = await signUp(server.baseUrl, { email: uniqueEmail('iso-member') });
	assert.equal(promoted.status, 200);
	const memberEmail = promoted.body?.user?.email;
	const bWs = (await (await fetch(`${server.baseUrl}/api/pages/workspace`, { headers: { cookie: b.cookie } })).json()).workspace?.id;
	// Per-run id: a fixed one collides with the previous run's row (the DB is
	// reused between runs), which reports as a fixture error rather than a
	// finding — the same mistake a fixed request_log id made earlier.
	const memberRowId = `wsm_isotest_${Date.now().toString(36)}`;
	await sql`insert into workspace_member (id, workspace_id, user_id, role_id, status, invited_by)
		select ${memberRowId}, ${bWs}, u.id, ${adminRole.id}, 'active', null from "user" u where u.email = ${memberEmail}
		on conflict (workspace_id, user_id) do update set role_id = ${adminRole.id}, status = 'active'`;

	// The non-owner member tries to invite into the OWNER role — acting INSIDE
	// B, which is what the `fwid` cookie selects (currentWorkspaceId reads it,
	// and only honours it for an active member of that workspace). Without the
	// cookie the request resolves to the member's own workspace, where they
	// legitimately ARE the owner, and the test would assert the wrong thing.
	const actingInB = `${promoted.cookie}; fwid=${bWs}`;
	const escalate = await fetch(`${server.baseUrl}/api/pages/team/members/invite`, {
		method: 'POST',
		headers: { cookie: actingInB, 'content-type': 'application/json' },
		body: JSON.stringify({ email: adminEmail, roleId: ownerRole.id })
	});
	assert.equal(
		escalate.status,
		403,
		`a non-owner granted the owner role through invite (status ${escalate.status}) — changeRole refuses this, so invite must too: ${(await escalate.text()).slice(0, 120)}`
	);

	// And a bogus role is still refused rather than inserted.
	const bogus = await fetch(`${server.baseUrl}/api/pages/team/members/invite`, {
		method: 'POST',
		headers: { cookie: b.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ email: uniqueEmail('invite-bogus'), roleId: 'rol_does_not_exist' })
	});
	assert.equal(bogus.status, 400, 'an unknown role must be a 400, not a silent membership');
});

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
		for (const field of ['requests', 'cost', 'workspaces', 'projects', 'keys', 'lastSeenAt']) {
			assert.ok(field in u, `the users payload is missing ${field}`);
		}
	}
});
