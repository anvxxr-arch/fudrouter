import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// The member surface requires a session. The hook already enforces the `member`
// capability; this is the second layer (defense in depth).
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return {};
};
