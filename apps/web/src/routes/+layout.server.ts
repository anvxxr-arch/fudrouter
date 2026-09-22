import type { LayoutServerLoad } from './$types';
import { capsFor } from '$lib/server/roles';

export const load: LayoutServerLoad = async ({ locals }) => {
	const role = (locals.user as { role?: string | null } | null)?.role ?? null;
	return {
		user: locals.user
			? {
					name: locals.user.name,
					email: locals.user.email,
					role: role ?? 'user'
				}
			: null,
		// Lets any surface render its chrome per viewer without a client fetch.
		caps: locals.user ? [...capsFor(role)] : []
	};
};
