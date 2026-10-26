// Section capability map + the admin dominance checks.
//
// ROLE_CAPS/capsFor are NOT defined here any more. They are the platform's table
// (@fudrouter/platform/rbac, re-exported through ./platform-ts.mjs) -- the same
// object the SPA's route guards read. Three copies used to exist: this file, the
// SPA's src/lib/caps.ts, and a literal in rbac.test.mjs that compared the first
// two by parsing the second one's source text. The live two agreed by luck, and
// nothing kept them in step. The enforcement path and the UI must not be able to
// disagree -- a control the API refuses is a bug, and a table the API does not
// use is a privilege-escalation hazard waiting for the next edit.
//
// What stays local: SECTION_CAPS (the section -> extra-cap map admin.mjs
// enforces endpoint by endpoint) and the dominance helpers.
import { ROLE_CAPS, capsFor } from './platform-ts.mjs';

export { ROLE_CAPS, capsFor };

// Section -> extra cap beyond admin.view (mirrors ROUTE_CAPS in roles.ts).
//
// Every key must name a section that still has an `/admin/<section>` route.
// `projects` and `workspaces` outlived their routes by one migration: 0019
// deleted both admin surfaces, and these two entries stayed behind. They were
// unreachable (no caller passes those section names any more), which is exactly
// why they were dangerous — a later section reusing either name would have
// silently inherited `admin.users` gating. The test below now asserts the
// mirror instead of trusting it.
export const SECTION_CAPS = {
	access: 'admin.access',
	analytics: 'admin.view',
	billing: 'admin.billing',
	connections: 'admin.ops',
	health: 'admin.ops',
	incidents: 'admin.ops',
	keys: 'admin.keys',
	models: 'admin.models',
	providers: 'admin.providers',
	requests: 'admin.requests',
	routing: 'admin.ops',
	security: 'admin.audit',
	settings: 'admin.settings',
	system: 'admin.ops',
	traffic: 'admin.ops',
	users: 'admin.users'
};

// The admin dominance helpers use the SAME `capsFor` table as routing. They
// used to carry a private `_capsFor` copy, which is a privilege-escalation
// hazard: the moment the two tables disagree, a grant check compares against a
// vocabulary the enforcement path does not use.
export const _dominates = (a, b) => { for (const c of b) if (!a.has(c)) return false; return true; };
export const _canAdminister = (actorRole, targetRole, granted) => { const a = capsFor(actorRole); if (!_dominates(a, capsFor(targetRole))) return false; if (granted !== undefined && granted !== null && !_dominates(a, capsFor(granted))) return false; return true; };
export const _guardUser = (actor, targetRole, granted) => { if (!_canAdminister(actor?.role ?? null, targetRole, granted)) return (granted !== undefined && granted !== targetRole) ? 'You cannot grant a role above your own level' : 'You cannot modify a user at or above your own level'; return null; };
