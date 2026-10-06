// Role capability tables + the admin dominance checks. ROLE_CAPS/capsFor were
// moved here from server/index.mjs (re-exported there for existing importers);
// SECTION_CAPS and the _guardUser family moved from server/admin.mjs.

export const ROLE_CAPS = {
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
export function capsFor(role) {
	return new Set(role && ROLE_CAPS[role] ? ROLE_CAPS[role] : ['member']);
}

// Section -> extra cap beyond admin.view (mirrors ROUTE_CAPS in roles.ts).
export const SECTION_CAPS = {
	analytics: 'admin.view',
	billing: 'admin.billing',
	connections: 'admin.ops',
	health: 'admin.ops',
	incidents: 'admin.ops',
	keys: 'admin.keys',
	models: 'admin.models',
	projects: 'admin.users',
	providers: 'admin.providers',
	requests: 'admin.requests',
	routing: 'admin.ops',
	security: 'admin.audit',
	settings: 'admin.settings',
	system: 'admin.ops',
	traffic: 'admin.ops',
	users: 'admin.users',
	workspaces: 'admin.users'
};

export const _capsFor = (role) => { const m = { user: ['member'], finance_admin: ['member', 'admin.view', 'admin.billing', 'admin.users'], ops_admin: ['member', 'admin.view', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops'], admin: ['member', 'admin.view', 'admin.users', 'admin.keys', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops', 'admin.billing', 'admin.audit', 'admin.settings'] }; return new Set(m[role] ?? ['member']); };
export const _dominates = (a, b) => { for (const c of b) if (!a.has(c)) return false; return true; };
export const _canAdminister = (actorRole, targetRole, granted) => { const a = _capsFor(actorRole); if (!_dominates(a, _capsFor(targetRole))) return false; if (granted !== undefined && granted !== null && !_dominates(a, _capsFor(granted))) return false; return true; };
export const _guardUser = (actor, targetRole, granted) => { if (!_canAdminister(actor?.role ?? null, targetRole, granted)) return (granted !== undefined && granted !== targetRole) ? 'You cannot grant a role above your own level' : 'You cannot modify a user at or above your own level'; return null; };
