/**
 * Page titles. One map, template match — the same resolution rule the
 * capability guard uses, so a nested path inherits its section's title instead
 * of inventing one. Without this the console had no <title> at all, which costs
 * screen-reader users the page name and leaves every tab reading "localhost".
 *
 * Bracket-aware: a key segment like `[projectId]` matches ANY single path
 * segment, so the same entry serves the literal route template the tests and
 * nav use (`/dashboard/projects/[projectId]/requests`) and the runtime URL
 * (`/dashboard/projects/prj_0192…/requests`). The longest matching TEMPLATE
 * wins, so `/dashboard/projects/[projectId]/requests/[requestId]`
 * ('Request Detail') beats its parent list entry ('Request Logs') — templates
 * are compared by segment count, not by the length of whatever id arrived.
 */
const TITLES: Record<string, string> = {
	'/': 'Home',
	'/pricing': 'Pricing',
	'/models': 'Models',
	'/models/compare': 'Compare Models',
	'/models/[slug]': 'Model Detail',
	'/providers': 'Providers',
	'/providers/[slug]': 'Provider Detail',
	'/playground': 'Playground',
	'/docs': 'Documentation',
	'/docs/[...slug]': 'Documentation',
	'/changelog': 'Changelog',
	'/changelog/[slug]': 'Changelog Entry',
	'/status': 'Status',
	'/status/incidents/[id]': 'Incident',
	'/legal/terms': 'Terms of Service',
	'/legal/privacy': 'Privacy Policy',
	'/login': 'Log in',
	'/signup': 'Create account',
	'/dashboard': 'Dashboard',
	'/dashboard/keys': 'API Keys',
	'/dashboard/playground': 'Playground',
	'/dashboard/usage': 'Usage',
	'/dashboard/account': 'Account',
	'/dashboard/billing': 'Billing',
	'/dashboard/billing/credits': 'Credits',
	'/dashboard/billing/transactions': 'Transactions',
	'/dashboard/billing/invoices': 'Invoices',
	'/dashboard/billing/payment-methods': 'Payment methods',
	'/dashboard/workspace': 'Workspace Settings',
	'/dashboard/projects': 'Projects',
	'/dashboard/projects/new': 'New Project',
	'/dashboard/projects/[projectId]': 'Project',
	'/dashboard/projects/[projectId]/settings': 'Project Settings',
	'/dashboard/projects/[projectId]/environments': 'Environments',
	'/dashboard/projects/[projectId]/playground': 'Project playground',
	'/dashboard/projects/[projectId]/aliases': 'Model aliases',
	'/dashboard/projects/[projectId]/routing': 'Routing policy',
	'/dashboard/projects/[projectId]/keys': 'Project API Keys',
	'/dashboard/projects/[projectId]/keys/[keyId]': 'API Key',
	'/dashboard/projects/[projectId]/requests': 'Request Logs',
	'/dashboard/projects/[projectId]/requests/[requestId]': 'Request Detail',
	'/dashboard/projects/[projectId]/analytics': 'Analytics',
	'/dashboard/projects/[projectId]/budgets': 'Budgets',
	'/dashboard/projects/[projectId]/limits': 'Rate Limits',
	'/dashboard/projects/[projectId]/alerts': 'Alerts',
	'/dashboard/team': 'Team',
	'/dashboard/team/members': 'Members',
	'/dashboard/team/invitations': 'Invitations',
	'/dashboard/team/roles': 'Roles',
	'/invite': 'Invitation',
	'/invite/[token]': 'Accept Invitation',
	'/admin': 'Admin overview',
	'/admin/providers': 'Providers',
	'/admin/models': 'Models',
	'/admin/keys': 'Client API keys',
	'/admin/users': 'Users',
	'/admin/requests': 'API call history',
	'/admin/connections': 'Connections'
};
const SITE = 'fudrouter';
/** Does `template` match `path` segment-for-segment, `[param]` matching anything,
 * `[...rest]` matching one or more trailing segments (a SvelteKit catch-all). */
function matches(template: string, path: string): boolean {
	const t = template.split('/').filter(Boolean);
	const p = path.split('/').filter(Boolean);
	for (let i = 0; i < t.length; i++) {
		const seg = t[i];
		if (seg.startsWith('[...') && seg.endsWith(']')) return p.length > i;
		if (i >= p.length) return false;
		if (seg.startsWith('[') && seg.endsWith(']')) {
			if (p[i].length === 0) return false;
			continue;
		}
		if (seg !== p[i]) return false;
	}
	return t.length === p.length;
}
/** Full document title for a path, e.g. `Pricing — fudrouter`. */
export function titleFor(pathname: string): string {
	// Exact hit first, so a literal template key always beats wildcard matching.
	const exact = TITLES[pathname];
	if (exact) return `${exact} — ${SITE}`;
	let best: { key: string; rank: number } | null = null;
	for (const key of Object.keys(TITLES)) {
		if (key === '/') continue;
		if (!matches(key, pathname)) continue;
		// Longest matching TEMPLATE wins, then the most literal one — so
		// `/models/compare` (both segments literal) beats `/models/[slug]` for the
		// path `/models/compare` even though both have two segments.
		const segs = key.split('/').filter(Boolean);
		const literal = segs.filter((s) => !s.startsWith('[')).length;
		const rank = segs.length * 10_000 + literal * 100 + key.length;
		if (!best || rank > best.rank) best = { key, rank };
	}
	return best ? `${TITLES[best.key]} — ${SITE}` : SITE;
}
