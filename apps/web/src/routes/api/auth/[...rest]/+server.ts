import type { RequestEvent } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { toSvelteKitHandler } from 'better-auth/svelte-kit';
import { isAllowedOrigin } from '$lib/server/origins';

const handler = toSvelteKitHandler(auth);

/**
 * Mutating auth calls must carry a trusted Origin when one is present.
 *
 * The catch-all was the only auth route with NO explicit origin check (unlike
 * `sign-in/social` and `callback/discord`), so it leaned entirely on better-auth's
 * own CSRF. A present-but-untrusted Origin is refused; a MISSING Origin is allowed
 * so non-browser clients (curl, the CLI) keep working — a browser always sends
 * Origin on a cross-site POST, which is the case this guards.
 */
async function guarded(event: RequestEvent) {
	const origin = event.request.headers.get('Origin');
	if (origin !== null && !isAllowedOrigin(origin)) {
		return new Response(JSON.stringify({ error: 'forbidden_origin' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	return handler(event);
}

export const GET = handler;
export const POST = guarded;
export const PATCH = guarded;
export const PUT = guarded;
export const DELETE = guarded;
