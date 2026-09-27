import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { hasCap, requiredCap } from '$lib/server/roles';

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	// A database hiccup must not take the whole site down. getSession was
	// unguarded, so any transient DB error threw here and turned EVERY route
	// into a 500 — including the public landing page and /status, which are the
	// pages an operator (and an uptime monitor) reaches for exactly then.
	//
	// Failing to "anonymous" is the safe direction: the capability gate below
	// denies rather than grants when there is no user, so a session that cannot
	// be verified is treated as no session.
	let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
	try {
		session = await auth.api.getSession({ headers: event.request.headers });
	} catch (err) {
		console.error('[hooks] session lookup failed; treating request as anonymous', err);
	}

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

	return resolve(event);
};

export const handle: Handle = handleBetterAuth;
