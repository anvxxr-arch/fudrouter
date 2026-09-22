import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { landingFor } from '$lib/server/roles';

// Signed-in users land on their own home, so `/` is never a dead end.
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		const role = (locals.user as { role?: string | null }).role;
		redirect(303, landingFor(role));
	}
	return {};
};

export const actions: Actions = {
	// POST /?/logout — the nav's sign-out form targets this.
	logout: async (event) => {
		await auth.api.signOut({ headers: event.request.headers });
		redirect(303, '/login');
	}
};
