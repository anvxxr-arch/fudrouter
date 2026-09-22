import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { hasCap, requiredCap } from '$lib/server/roles';

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	if (!building) {
		const cap = requiredCap(event.url.pathname);
		if (cap) {
			// Anonymous → login. Signed in but lacking the cap → their own home,
			// so they are never bounced to a login form they already cleared.
			if (!event.locals.user) redirect(303, '/login');
			const role = (event.locals.user as { role?: string | null }).role;
			if (!hasCap(role, cap)) redirect(303, '/');
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
