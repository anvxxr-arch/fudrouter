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

/** True when `actor` holds every capability `target` holds (a superset test). */
export function capsDominate(actor: Set<Capability>, target: Set<Capability>): boolean {
	for (const cap of target) if (!actor.has(cap)) return false;
	return true;
}

/**
 * Privilege ordering for user administration.
 *
 * An actor may only act on a target whose capabilities it dominates, and may
 * only grant a role it also dominates. Identity alone is NOT enough: a guard that
 * only blocks self-demotion let `finance_admin` (which holds `admin.users` but
 * not `admin`) promote itself to full admin. `admin` dominates everything, so it
 * still administers every account.
 */
export function canAdminister(
	actorRole: string | null | undefined,
	targetRole: string | null | undefined,
	grantedRole?: string | null
): boolean {
	const actor = capsFor(actorRole);
	if (!capsDominate(actor, capsFor(targetRole))) return false;
	if (grantedRole !== undefined && grantedRole !== null) {
		if (!capsDominate(actor, capsFor(grantedRole))) return false;
	}
	return true;
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
	// PRD §50's remaining admin areas (Security Center, System, Traffic,
	// Routing, Incidents, customer workspaces/projects, analytics). Cap choice:
	// security/audit share one trust boundary (admin.audit); operational
	// surfaces (system/traffic/routing/incidents) are admin.ops; customer
	// resource listings are admin.users; read-only analytics is admin.view.
	['/admin/security', 'admin.audit'],
	['/admin/incidents', 'admin.ops'],
	['/admin/system', 'admin.ops'],
	['/admin/traffic', 'admin.ops'],
	['/admin/routing', 'admin.ops'],
	['/admin/health', 'admin.ops'],
	['/admin/workspaces', 'admin.users'],
	['/admin/projects', 'admin.users'],
	['/admin/analytics', 'admin.view'],
	['/admin', 'admin.view'],
	['/dashboard', 'member'],
	['/dashboard/keys', 'member'],
	['/dashboard/usage', 'member'],
	['/dashboard/account', 'member'],
	['/dashboard/billing', 'member'],
	['/dashboard/connect', 'member'],
	// Not under /dashboard: the signed-in invitation acceptance page (PRD §12).
	// Entries use SvelteKit route patterns — `[param]` matches any one segment.
	// `requiredCap` matches SEGMENT-wise (not raw startsWith) because the hook
	// calls it with REAL urls (/invite/abc123) while route-gates.test.ts passes
	// the literal template (/invite/[token]): both must resolve to the same cap.
	// Plain prefix matching made /invite/[token] pass the test while returning
	// null for the actual request — gated in CI, wide open at runtime.
	['/invite/[token]', 'member']
];

const seg = (p: string): string[] => p.split('/').filter(Boolean);

/** Does `entry` prefix-match `path`? `[param]` = any one segment, `[...x]` = rest. */
function entryMatches(entry: string[], path: string[]): boolean {
	for (let i = 0; i < entry.length; i++) {
		const e = entry[i];
		if (e.startsWith('[...') && e.endsWith(']')) return true;
		if (i >= path.length) return false;
		if (e.startsWith('[') && e.endsWith(']')) continue;
		if (e !== path[i]) return false;
	}
	return true;
}

export function requiredCap(pathname: string): Capability | null {
	const path = seg(pathname);
	let best: { entry: string[]; cap: Capability } | null = null;
	for (const [pattern, cap] of ROUTE_CAPS) {
		const entry = seg(pattern);
		if (!entryMatches(entry, path)) continue;
		if (
			!best ||
			entry.length > best.entry.length ||
			(entry.length === best.entry.length &&
				entry.filter((s) => !s.startsWith('[')).length >
					best.entry.filter((s) => !s.startsWith('[')).length)
		) {
			best = { entry, cap };
		}
	}
	return best?.cap ?? null;
}
