// Unit tests for the role-capability table and the admin dominance checks.
//
// Two properties matter and both have been a finding:
//  1. the server table is the enforcement vocabulary, so it is pinned here;
//  2. the console's table (src/lib/caps.ts) must not drift from it — a private
//     copy (`_capsFor`) once existed on the server side, which is a
//     privilege-escalation hazard the moment the two disagree. The cross-check
//     below parses the TS source so a drift in either file fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROLE_CAPS, capsFor, SECTION_CAPS, _dominates, _canAdminister, _guardUser } from './rbac.mjs';

const EXPECTED = {
	user: ['member'],
	finance_admin: ['member', 'admin.view', 'admin.billing', 'admin.users'],
	ops_admin: ['member', 'admin.view', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops'],
	admin: [
		'member', 'admin.view', 'admin.users', 'admin.keys', 'admin.providers',
		'admin.models', 'admin.requests', 'admin.ops', 'admin.billing', 'admin.audit', 'admin.settings'
	]
};

test('server ROLE_CAPS matches the spec exactly', () => {
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

test('the console table does not drift from the server table', () => {
	const src = readFileSync(new URL('../../src/lib/caps.ts', import.meta.url), 'utf8');
	const block = src.match(/const ROLE_CAPS[^=]*=\s*\{([\s\S]*?)\n\};/);
	assert.ok(block, 'could not locate ROLE_CAPS in src/lib/caps.ts — update this test to match the new shape');
	const tsCaps = {};
	for (const m of block[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[([^\]]*)\]/g)) {
		tsCaps[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
	}
	assert.deepEqual(Object.keys(tsCaps).sort(), Object.keys(ROLE_CAPS).sort(), 'role set differs');
	for (const role of Object.keys(ROLE_CAPS)) {
		assert.deepEqual(tsCaps[role], [...ROLE_CAPS[role]].sort(), `role ${role} differs between server and console`);
	}
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

test('SECTION_CAPS only names known capabilities', () => {
	const known = new Set(Object.values(EXPECTED).flat());
	for (const [section, cap] of Object.entries(SECTION_CAPS)) {
		assert.ok(known.has(cap), `section ${section} maps to unknown cap ${cap}`);
	}
});
