// tests/integration/ban-revocation.test.mjs — banning a user must end their
// sessions.
//
// Why this file exists: BAN-REVOCATION. The admin handlers (toggleBan,
// suspend, disableAccess) set `banned` and deleted session rows, and the audit
// metadata claimed sessionsRevoked:true — but better-auth core validates a
// session by expiry only (dist/api/routes/session.mjs findSession) and the
// admin plugin that would enforce `banned` is deliberately not loaded
// (index.mjs "No plugins" note). Measured over HTTP before the fix: a banned
// user's ORIGINAL cookie still answered /api/auth/get-session with 200, and a
// fresh sign-in minted a NEW session for the banned account. The delete raced
// nothing — the surviving row was created after the ban committed. This is a
// security invariant with no natural detector: nothing crashes, nothing logs,
// the UI confirm text simply lies. These tests pin the invariant.
//
// The load-bearing assertions are the two the old code failed: the original
// cookie must stop validating (401/403), and a fresh sign-in must be refused
// (the session.create.before hook in index.mjs, mirroring the admin plugin's
// own hook at dist/plugins/admin/admin.mjs:33-51).
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
let adminCookie;

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
	sql = postgres(process.env.DATABASE_URL, { max: 2 });
	// Admin is granted by a row update, not a new session (the promotion
	// pattern tenant-isolation.test.mjs uses): a fresh sign-up is a plain
	// member, so without this every admin POST below is a 403.
	const admin = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(admin.status, 200, `sign-up failed: ${JSON.stringify(admin.body)}`);
	await sql`update "user" set role = 'admin' where email = ${admin.body?.user?.email}`;
	adminCookie = admin.cookie;
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

// One driver for all three endpoints that claim "sessions are revoked":
// ban the victim, then prove the ORIGINAL cookie is dead. `bansAccount` is
// false only for disableAccess, which deliberately leaves `banned = false`
// (it disables keys, not the account), so a fresh sign-in there is allowed by
// design — its claim is about the sessions that existed, which must be gone.
async function assertBanRevokesSessions(endpoint, body, bansAccount = true) {
	const victim = await signUp(server.baseUrl, { email: uniqueEmail('victim') });
	assert.equal(victim.status, 200, `sign-up failed: ${JSON.stringify(victim.body)}`);
	const victimEmail = victim.body?.user?.email;
	const [row] = await sql`select id from "user" where email = ${victimEmail}`;

	// The cookie must be live BEFORE the ban, or the test proves nothing.
	const pre = await fetch(`${server.baseUrl}/api/auth/get-session`, { headers: { cookie: victim.cookie } });
	assert.equal(pre.status, 200, `pre-ban get-session = ${pre.status}: the fixture cookie must be live`);

	const ban = await fetch(`${server.baseUrl}/api/admin/users/${endpoint}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://127.0.0.1:3000' },
		body: JSON.stringify(body(row.id))
	});
	assert.equal(ban.status, 200, `ban = ${ban.status}: ${await ban.text().then((t) => t.slice(0, 160))}`);

	// The ORIGINAL cookie must now be dead. 401/403, not 200-with-null.
	const post = await fetch(`${server.baseUrl}/api/auth/get-session`, { headers: { cookie: victim.cookie } });
	assert.ok(post.status === 401 || post.status === 403, `post-ban get-session with the ORIGINAL cookie = ${post.status} (expected 401/403)`);

	if (bansAccount) {
		// A fresh sign-in must be refused: the session.create.before hook in
		// index.mjs is what stops the banned account from minting a new session.
		const fresh = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: victimEmail, password: 'integration-pw-123' })
		});
		assert.ok(fresh.status === 401 || fresh.status === 403, `fresh sign-in as banned user = ${fresh.status} (expected 401/403)`);
	}

	// No live session row may survive the action.
	const [count] = await sql`select count(*)::int as n from session where user_id = ${row.id}`;
	assert.equal(count.n, 0, `session rows for the revoked user must be gone (got ${count.n})`);
}

test('toggleBan revokes the victim\'s original cookie and refuses fresh sign-in', NEEDS_DB, async () => {
	await assertBanRevokesSessions('toggleBan', (id) => ({ id }));
});

test('suspend revokes the victim\'s original cookie and refuses fresh sign-in', NEEDS_DB, async () => {
	await assertBanRevokesSessions('suspend', (id) => ({ id, confirm: 'on' }));
});

test('disableAccess revokes the victim\'s original cookie', NEEDS_DB, async () => {
	await assertBanRevokesSessions('disableAccess', (id) => ({ id, confirm: 'on' }), false);
});
