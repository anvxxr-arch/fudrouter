import { auth } from '$lib/server/auth';
import { env } from '$env/dynamic/private';

export async function POST({ request, url }: { request: Request; url: URL }) {
	const origin = request.headers.get('Origin');
	if (origin !== 'https://ai.karepmuwes.my.id' && origin !== 'http://localhost:3000' && origin !== 'http://127.0.0.1:3000') {
		return new Response(JSON.stringify({ error: 'forbidden_origin' }), { status: 403 });
	}
	return auth.handler(request);
}

export async function GET({ request }: { request: Request }) {
	return auth.handler(request);
}
