// Unit tests for the role-capability table, the admin dominance checks, and the
// two maps that must agree with the table.
//
// Two properties matter and both have been a finding:
//
//  1. the enforcement vocabulary is pinned to the spec here;
//  2. nothing that gates a route or a section may name a capability the table
//     does not contain.
//
// The SPA used to carry its own role table and this suite compared the two by
// PARSING src/lib/caps.ts as source text -- a check that went red on a
// reformatting and green on any drift that kept the parsed shape. Both sides now
// read one table (packages/platform/rbac.ts, re-exported by server/lib/rbac.mjs
// and by the SPA's caps.ts), so the checks below are semantic: they import the
// SPA's own ROUTE_CAPS and assert every capability it names is real, and that
// the SPA's guard answers from the same table the server enforces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_CAPS, capsFor, SECTION_CAPS, _dominates, _canAdminister, _guardUser } from './rbac.mjs';
import { ROUTE_CAPS, requiredCap, hasCap } from '../../src/lib/caps.ts';

const EXPECTED = {
	user: ['member'],
	finance_admin: ['member', 'billing.credit', 'admin.view', 'admin.billing', 'admin.users'],
	ops_admin: ['member', 'admin.view', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops'],
	admin: [
		'member', 'billing.credit', 'admin.view', 'admin.users', 'admin.access', 'admin.keys',
		'admin.providers', 'admin.models', 'admin.requests', 'admin.ops', 'admin.billing',
		'admin.audit', 'admin.settings'
	]
};

test('ROLE_CAPS matches the spec exactly', () => {
	assert.deepEqual(Object.keys(ROLE_CAPS).sort(), Object.keys(EXPECTED).sort());
	for (const [role, caps] of Object.entries(EXPECTED)) {
		assert.deepEqual([...capsFor(role)].sort(), [...caps].sort(), `caps for ${role}`);
	}
});

test('capsFor defaults an unknown or missing role to member only', () => {
	for (const role of [undefined, null, '', 'root', 'superuser']) {
		assert.deepEqual([...capsFor(role)], ['member'], `role ${JSON.stringify(role)}`);
	}
});

test('SECTION_CAPS and the SPA ROUTE_CAPS only name real capabilities', () => {
	const known = new Set(Object.values(EXPECTED).flat());
	for (const [section, cap] of Object.entries(SECTION_CAPS)) {
		assert.ok(known.has(cap), `section ${section} maps to unknown cap ${cap}`);
	}
	assert.ok(ROUTE_CAPS.length > 0, 'the SPA route map is empty');
	for (const [pattern, cap] of ROUTE_CAPS) {
		assert.ok(known.has(cap), `SPA route ${pattern} maps to unknown cap ${cap}`);
	}
});

test('SECTION_CAPS names only sections that still have an admin route', () => {
	// The mirror this table's comment claims, asserted instead of trusted.
	// `projects` and `workspaces` survived migration 0019 here for a whole
	// release: their routes were deleted, so nothing passed those section names,
	// so nothing failed — and a future section reusing either name would have
	// silently inherited its cap. Checking only that the CAP is real cannot see
	// that; checking the SECTION against the route map can.
	const routed = new Set(
		ROUTE_CAPS.filter(([pattern]) => pattern.startsWith('/admin/'))
			.map(([pattern]) => pattern.slice('/admin/'.length).split('/')[0])
	);
	for (const section of Object.keys(SECTION_CAPS)) {
		assert.ok(
			routed.has(section),
			`SECTION_CAPS gates "${section}" but no /admin/${section} route exists — remove the entry or add the route`
		);
	}
});

test('the SPA guard answers from the table the server enforces', () => {
	// Same table, so this pins the SPA side of the seam: for every role, hasCap
	// must agree with capsFor for every capability in the vocabulary. A cap the
	// SPA's type lacks silently hides a control the API allows; one the table
	// lacks shows a control the API refuses with a 403.
	for (const [role, caps] of Object.entries(ROLE_CAPS)) {
		for (const cap of Object.values(ROLE_CAPS).flat()) {
			assert.equal(hasCap(role, cap), caps.includes(cap), `${role} / ${cap}`);
		}
	}
	assert.equal(hasCap(null, 'member'), true);
	assert.equal(hasCap('ops_admin', 'admin.keys'), false);
});

test('requiredCap picks the longest matching route prefix', () => {
	assert.equal(requiredCap('/admin/keys'), 'admin.keys');
	assert.equal(requiredCap('/admin/providers/12'), 'admin.providers');
	assert.equal(requiredCap('/admin/models'), 'admin.models');
	// listed after /admin, so the longer entry must win
	assert.equal(requiredCap('/admin/security'), 'admin.audit');
	// the bare prefix falls back to the widest entry
	assert.equal(requiredCap('/admin'), 'admin.view');
	assert.equal(requiredCap('/admin/unknown-section'), 'admin.view');
	assert.equal(requiredCap('/dashboard/team/roles'), 'member');
	assert.equal(requiredCap('/public'), null);
});

test('_dominates requires a superset', () => {
	const admin = capsFor('admin');
	const ops = capsFor('ops_admin');
	assert.equal(_dominates(admin, ops), true);
	assert.equal(_dominates(ops, admin), false);
	assert.equal(_dominates(admin, admin), true);
});

test('_canAdminister forbids acting on a role you do not dominate', () => {
	// an admin may manage lower roles and grant lower roles
	assert.equal(_canAdminister('admin', 'ops_admin'), true);
	assert.equal(_canAdminister('admin', 'user', 'finance_admin'), true);
	// equal rank dominates itself, so peers may manage peers (unchanged behaviour)
	assert.equal(_canAdminister('admin', 'admin'), true);
	// but a lower role may not touch a higher one, nor grant above itself
	assert.equal(_canAdminister('ops_admin', 'admin'), false);
	assert.equal(_canAdminister('ops_admin', 'user', 'admin'), false);
	// an unknown actor role has only `member`
	assert.equal(_canAdminister('user', 'user'), true);
	assert.equal(_canAdminister('user', 'ops_admin'), false);
});

test('_guardUser returns the right refusal message', () => {
	assert.equal(_guardUser({ role: 'admin' }, 'user'), null);
	assert.match(String(_guardUser({ role: 'ops_admin' }, 'admin')), /at or above your own level/);
	assert.match(String(_guardUser({ role: 'ops_admin' }, 'user', 'admin')), /above your own level/);
});
