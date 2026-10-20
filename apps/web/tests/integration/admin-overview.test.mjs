// tests/integration/admin-overview.test.mjs — the /admin overview payload.
//
// Why this file exists: the overview page gained three sections that read
// server-computed aggregates the SPA cannot derive itself — a 14-day
// usage_daily series (stat-card deltas + sparklines), a 12-month ledger
// series (revenue chart), and per-user firstRequestAt/workspaceName (recent
// signups). Each is a shape the client trusts: a missing or short series
// renders a silently wrong chart rather than an error, which is the failure
// mode with no natural detector. These tests pin the shapes.
//
// The zero-fill assertions are the load-bearing ones: a fresh database has no
// usage_daily rows and no ledger rows, so the handlers must still return a
// FULL-LENGTH series (14 days / 12 months) rather than an empty array. The
// pre-fix shape of this code returned nothing at all for those keys.
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
	// member, so without this every request below is a 403.
	const admin = await signUp(server.baseUrl, { email: uniqueEmail('admin') });
	assert.equal(admin.status, 200, `sign-up failed: ${JSON.stringify(admin.body)}`);
	await sql`update "user" set role = 'admin' where email = ${admin.body?.user?.email}`;
	adminCookie = admin.cookie;
});

test.after(async () => {
	await server?.stop();
	await sql?.end({ timeout: 5 });
});

test('/api/admin/overview carries a full 14-day series and revenue MTD', NEEDS_DB, async () => {
	const res = await fetch(`${server.baseUrl}/api/admin/overview`, { headers: { cookie: adminCookie } });
	const text = await res.text();
	assert.equal(res.status, 200, `overview = ${res.status}: ${text.slice(0, 160)}`);
	const body = JSON.parse(text);

	// The series must be zero-filled to 14 entries even with no usage_daily
	// rows: the sparklines and today-vs-yesterday deltas index the last two
	// entries, and a short array silently drops the delta instead of failing.
	assert.ok(Array.isArray(body.series), 'the overview payload must carry a series array');
	assert.equal(body.series.length, 14, `the series must be zero-filled to 14 days (got ${body.series.length})`);
	for (const s of body.series) {
		assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.day), `series day must be YYYY-MM-DD (got ${s.day})`);
		assert.equal(typeof s.requests, 'number', 'series requests must be a number');
		assert.equal(typeof s.tokens, 'number', 'series tokens must be a number');
		assert.equal(typeof s.costMicro, 'string', 'series costMicro must be a string (micros are bigint)');
	}
	assert.equal(typeof body.revenueMtdMicro, 'string', 'revenueMtdMicro must be a string (micros are bigint)');
	assert.equal(typeof body.counts.workspaces, 'number', 'counts must carry the workspaces number');
});

test('/api/admin/billing carries a full 12-month ledger series', NEEDS_DB, async () => {
	const res = await fetch(`${server.baseUrl}/api/admin/billing`, { headers: { cookie: adminCookie } });
	const text = await res.text();
	assert.equal(res.status, 200, `billing = ${res.status}: ${text.slice(0, 160)}`);
	const body = JSON.parse(text);

	// Zero-filled to 12 months × the six ledger types: the stacked chart
	// indexes series[0] for the legend and every month for the segments, so a
	// short array renders a truncated axis rather than an error.
	assert.ok(Array.isArray(body.monthly), 'the billing payload must carry a monthly array');
	assert.equal(body.monthly.length, 12, `monthly must be zero-filled to 12 months (got ${body.monthly.length})`);
	for (const m of body.monthly) {
		assert.ok(/^\d{4}-\d{2}$/.test(m.month), `monthly month must be YYYY-MM (got ${m.month})`);
		assert.equal(m.series.length, 6, `each month must carry all six ledger types (got ${m.series.length})`);
		for (const s of m.series) {
			assert.equal(typeof s.totalMicro, 'string', 'ledger totals must be strings (micros are bigint)');
		}
	}
});

test('/api/admin/users carries firstRequestAt and workspaceName', NEEDS_DB, async () => {
	const res = await fetch(`${server.baseUrl}/api/admin/users`, { headers: { cookie: adminCookie } });
	const text = await res.text();
	assert.equal(res.status, 200, `users = ${res.status}: ${text.slice(0, 160)}`);
	const body = JSON.parse(text);
	assert.ok(Array.isArray(body.users), 'the payload must carry a users array');
	assert.ok(body.users.length > 0, 'the sign-up in test.before must be listed');
	for (const u of body.users) {
		assert.ok('firstRequestAt' in u, 'the users payload is missing firstRequestAt');
		assert.ok('workspaceName' in u, 'the users payload is missing workspaceName');
	}
	// The sign-up in test.before provisioned a workspace, so the newest user
	// (ordered createdAt desc) must carry its name — the join, not just the key.
	const newest = body.users[0];
	assert.equal(typeof newest.workspaceName, 'string', `the newest user must carry a workspace name (got ${newest.workspaceName})`);
});
