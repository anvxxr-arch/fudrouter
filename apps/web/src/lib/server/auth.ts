import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin } from 'better-auth/plugins';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import * as authSchema from '$lib/server/db/auth.schema';

export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
	// baseURL is the public origin (https://ai.karepmuwes.my.id). Keep the local
	// dev origins trusted so `localhost:3000` / `127.0.0.1:3000` logins still work
	// while the same build serves the tunnel.
	trustedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
	emailAndPassword: { enabled: true },
	plugins: [
		admin({
			defaultRole: 'user'
		}),
		sveltekitCookies(getRequestEvent) // must be the last plugin in the array
	]
});
