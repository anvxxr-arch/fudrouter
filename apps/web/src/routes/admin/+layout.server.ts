import type { LayoutServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';

// The hook gates `/admin/*`; this re-checks in the layout so every admin page
// inherits a verified capability (defense in depth).
export const load: LayoutServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.view');
	return {};
};
