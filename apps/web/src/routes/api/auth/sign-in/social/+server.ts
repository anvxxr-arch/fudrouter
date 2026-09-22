import { auth } from '$lib/server/auth';
import { isAllowedOrigin } from '$lib/server/origins';

export async function POST({ request }: { request: Request }) {
	if (!isAllowedOrigin(request.headers.get('Origin'))) {
		return new Response(JSON.stringify({ error: 'forbidden_origin' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	return auth.handler(request);
}

export async function GET({ request }: { request: Request }) {
	return auth.handler(request);
}
