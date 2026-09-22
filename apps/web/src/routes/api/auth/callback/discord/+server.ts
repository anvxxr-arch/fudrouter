import { env } from '$env/dynamic/private';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';

const CLIENT_ID = env.FLEXYROUTE_CLIENT_ID;
const CLIENT_SECRET = env.FLEXYROUTE_CLIENT_SECRET;
const REDIRECT_URI = `${env.ORIGIN}/api/auth/callback/discord`;
const DISCORD_API = 'https://discord.com/api/v10';

export async function GET({ url }: { url: URL }) {
	const code = url.searchParams.get('code');
	if (!code) throw redirect(303, '/login');

	const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT_URI
		})
	});
	if (!tokenRes.ok) throw redirect(303, '/login');

	const token = await tokenRes.json();
	const userRes = await fetch(`${DISCORD_API}/users/@me`, {
		headers: { Authorization: `Bearer ${token.access_token}` }
	});
	if (!userRes.ok) throw redirect(303, '/login');

	const discordUser = await userRes.json();
	const email = discordUser.email;
	if (!email) throw redirect(303, '/login');

	// Find or create user via better-auth
	const existing = await auth.api.user({ query: { email } });
	if (!existing) {
		await auth.api.createUser({
			body: {
				email,
				password: crypto.randomUUID(),
				name: discordUser.global_name ?? discordUser.username,
				role: 'user',
				emailVerified: true
			}
		});
	}

	const session = await auth.api.signInEmail({ body: { email, password: '' } });
	// TODO: fix password-less sign-in for OAuth-only users
	throw redirect(303, '/dashboard');
}
