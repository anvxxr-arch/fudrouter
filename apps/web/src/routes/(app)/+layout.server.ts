import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';

// The member surface needs a session, then the capability. The hook is the first
// gate; this is the second, so a change to the route table alone can never open
// this area to a signed-in user who lacks `member`.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	requireCap(locals, 'member');
	return {};
};
