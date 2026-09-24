import { error } from '@sveltejs/kit';

/**
 * Role → capability model (spec §8). Pages gate on CAPABILITIES, never on a
 * literal role string, so adding a role is one line here and never a schema or
 * route change. Unknown/absent roles fall back to `member` — never to admin.
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
	| 'admin.programs'
	| 'admin.audit'
	| 'admin.settings';

export const ALL_CAPS: Capability[] = [
	'member',
	'admin.view',
	'admin.users',
	'admin.keys',
	'admin.providers',
	'admin.models',
	'admin.requests',
	'admin.ops',
	'admin.billing',
	'admin.programs',
	'admin.audit',
	'admin.settings'
];

const ROLE_CAPS: Record<string, Capability[]> = {
	user: ['member'],
	finance_admin: ['member', 'admin.view', 'admin.billing', 'admin.users'],
	ops_admin: [
		'member',
		'admin.view',
		'admin.providers',
		'admin.models',
		'admin.requests',
		'admin.ops'
	],
	admin: ALL_CAPS
};

/** Capabilities for a role. Anything unrecognised (incl. null) gets `member`. */
export function capsFor(role?: string | null): Set<Capability> {
	const caps: Capability[] = role && ROLE_CAPS[role] ? ROLE_CAPS[role] : ['member'];
	return new Set(caps);
}

export function hasCap(role: string | null | undefined, cap: Capability): boolean {
	return capsFor(role).has(cap);
}

/** Defense-in-depth check for loads/actions; the hook is the first gate. */
export function requireCap(locals: App.Locals, cap: Capability): void {
	if (!locals.user) error(401, 'Authentication required');
	const role = (locals.user as { role?: string | null }).role;
	if (!hasCap(role, cap)) error(403, 'Forbidden');
}

/** Where a signed-in user belongs. */
export function landingFor(role?: string | null): string {
	return hasCap(role, 'admin.view') ? '/admin' : '/dashboard';
}

/**
 * Route → required capability. Longest matching prefix wins, so `/admin/billing`
 * (admin.billing) beats `/admin` (admin.view). A path with no entry is public.
 */
export const ROUTE_CAPS: [string, Capability][] = [
	['/admin/providers', 'admin.providers'],
	['/admin/models', 'admin.models'],
	['/admin/keys', 'admin.keys'],
	['/admin/users', 'admin.users'],
	['/admin/requests', 'admin.requests'],
	['/admin/connections', 'admin.ops'],
	['/admin/billing', 'admin.billing'],
	['/admin/revenue', 'admin.billing'],
	['/admin/transactions', 'admin.billing'],
	['/admin/programs', 'admin.programs'],
	['/admin/audit', 'admin.audit'],
	['/admin/settings', 'admin.settings'],
	['/admin', 'admin.view'],
	['/dashboard', 'member'],
	['/dashboard/keys', 'member'],
	['/dashboard/usage', 'member'],
	['/dashboard/account', 'member'],
	['/dashboard/billing', 'member']
];

export function requiredCap(pathname: string): Capability | null {
	let best: { prefix: string; cap: Capability } | null = null;
	for (const [prefix, cap] of ROUTE_CAPS) {
		if (pathname === prefix || pathname.startsWith(prefix + '/')) {
			if (!best || prefix.length > best.prefix.length) best = { prefix, cap };
		}
	}
	return best?.cap ?? null;
}
