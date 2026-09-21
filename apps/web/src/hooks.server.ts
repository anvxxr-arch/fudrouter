import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';

const PROTECTED = ['/keys', '/usage', '/admin'];
const ADMIN_ONLY = ['/admin'];

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	const path = event.url.pathname;
	if (!building && PROTECTED.some((p) => path.startsWith(p)) && !event.locals.user) {
		redirect(303, '/login');
	}
	if (!building && ADMIN_ONLY.some((p) => path.startsWith(p))) {
		const role = (event.locals.user as { role?: string } | null)?.role;
		if (role !== 'admin') {
			// Not a security boundary — the Go data plane re-enforces roles.
			redirect(303, '/login');
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
