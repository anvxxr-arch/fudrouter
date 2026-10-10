/**
 * The role -> capability table: who may reach which part of the admin surface.
 *
 * THE table. There used to be three copies of it -- the console server's
 * rbac.mjs, the SPA's src/lib/caps.ts, and a literal inside the test that
 * compared the first two by parsing the second one's source text. The two live
 * copies happened to agree; nothing made them, and the tripwire that was
 * supposed to notice a drift could only see a reformatting as a failure.
 *
 * Add a capability HERE and both sides get it: the server enforces it
 * (server/lib/rbac.mjs re-exports this through the platform bridge, admin.mjs
 * guards every endpoint from it) and the SPA can gate on it (src/lib/caps.ts
 * re-exports it, guards.tsx renders a section only when the cap is held). A UI
 * that shows a control the API refuses is a bug, not a defence -- so the two
 * read the same object, and the direction of truth is the enforcement path.
 *
 * Capabilities are the enforcement vocabulary; keep them in step with
 * SECTION_CAPS (server, which section needs which extra cap) and ROUTE_CAPS
 * (SPA, which route prefix). Both are checked against this list by
 * apps/console/server/lib/rbac.test.mjs.
 */

export type Capability =
	| 'member'
	| 'admin.view'
	| 'admin.users'
	| 'admin.keys'
	| 'admin.providers'
	| 'admin.models'
	| 'admin.requests'
	| 'admin.ops'
	| 'admin.billing'
	| 'admin.audit'
	| 'admin.settings';

export const ROLE_CAPS: Record<string, readonly Capability[]> = {
	user: ['member'],
	finance_admin: ['member', 'admin.view', 'admin.billing', 'admin.users'],
	ops_admin: ['member', 'admin.view', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops'],
	admin: [
		'member',
		'admin.view',
		'admin.users',
		'admin.keys',
		'admin.providers',
		'admin.models',
		'admin.requests',
		'admin.ops',
		'admin.billing',
		'admin.audit',
		'admin.settings'
	]
};

/**
 * The caps of a role. An unknown, missing or empty role gets `member` only --
 * this is the enforcement path, so anything unrecognised must fall to the
 * lowest privilege rather than to none (`capsFor` never returns an empty set,
 * because "no caps at all" reads as a config error and could be special-cased
 * somewhere; "member and nothing more" cannot).
 */
export function capsFor(role?: string | null): Set<Capability> {
	const caps = role && ROLE_CAPS[role] ? ROLE_CAPS[role] : ['member' as Capability];
	return new Set(caps);
}
