import { auth } from '$lib/server/auth';
import { env } from '$env/dynamic/private';

const ALLOWED_ORIGINS = [
	'https://ai.karepmuwes.my.id',
	'http://localhost:3000',
	'http://127.0.0.1:3000'
];

export async function GET({ request }: { request: Request }) {
	const origin = request.headers.get('Origin');
	if (origin && !ALLOWED_ORIGINS.includes(origin)) {
		return new Response(JSON.stringify({ error: 'forbidden_origin' }), { status: 403 });
	}
	return auth.handler(request);
}
