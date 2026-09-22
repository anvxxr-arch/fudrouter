import { auth } from '$lib/server/auth';

export async function POST(event: { request: Request; url: URL; locals: any }) {
	const url = new URL(event.url.pathname, 'http://localhost');
	if (url.pathname.startsWith('/api/auth/')) {
		return auth.handler(event.request);
	}
	return new Response('Not Found', { status: 404 });
}

export async function GET(event: { request: Request; url: URL }) {
	const url = new URL(event.url.pathname, 'http://localhost');
	if (url.pathname.startsWith('/api/auth/')) {
		return auth.handler(event.request);
	}
	return new Response('Not Found', { status: 404 });
}
