import { auth } from '$lib/server/auth';
import { isAllowedOrigin } from '$lib/server/origins';

// Discord's redirect back here is a top-level browser navigation, which sends no
// Origin header — so a missing Origin is allowed. A *present* but untrusted
// Origin is still rejected.
export async function GET({ request }: { request: Request }) {
	const origin = request.headers.get('Origin');
	if (origin !== null && !isAllowedOrigin(origin)) {
		return new Response(JSON.stringify({ error: 'forbidden_origin' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	return auth.handler(request);
}
