/**
 * Page titles. One map, longest-prefix match — the same resolution rule the
 * capability guard uses, so a nested path inherits its section's title instead
 * of inventing one. Without this the console had no <title> at all, which costs
 * screen-reader users the page name and leaves every tab reading "localhost".
 */
const TITLES: Record<string, string> = {
	'/': 'Home',
	'/pricing': 'Pricing',
	'/models': 'Models',
	'/docs': 'API reference',
	'/status': 'Status',
	'/legal/terms': 'Terms of Service',
	'/legal/privacy': 'Privacy Policy',
	'/login': 'Log in',
	'/signup': 'Create account',
	'/dashboard': 'Dashboard',
	'/dashboard/keys': 'API Keys',
	'/dashboard/usage': 'Usage',
	'/dashboard/account': 'Account',
	'/dashboard/billing': 'Billing',
	'/admin': 'Admin overview',
	'/admin/providers': 'Providers',
	'/admin/models': 'Models',
	'/admin/keys': 'Client API keys',
	'/admin/users': 'Users',
	'/admin/requests': 'API call history',
	'/admin/connections': 'Connections'
};

const SITE = 'fudrouter';

/** Full document title for a path, e.g. `Pricing — fudrouter`. */
export function titleFor(pathname: string): string {
	const exact = TITLES[pathname];
	if (exact) return `${exact} — ${SITE}`;

	let best = '';
	for (const key of Object.keys(TITLES)) {
		if (key !== '/' && pathname.startsWith(key + '/') && key.length > best.length) best = key;
	}
	return best ? `${TITLES[best]} — ${SITE}` : SITE;
}
