import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth';
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
	// baseURL is the public origin (https://ai.karepmuwes.my.id). The local dev
	// origins are trusted ONLY outside production — in prod they would widen CSRF
	// trust to a spoofable Origin for a convenience the ORIGIN binding already
	// makes unreachable.
	trustedOrigins:
		env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'],
	emailAndPassword: { enabled: true },
	socialProviders: {
		discord: {
			clientId: env.FLEXYROUTE_CLIENT_ID,
			clientSecret: env.FLEXYROUTE_CLIENT_SECRET,
			redirectURI: `${env.ORIGIN}/api/auth/callback/discord`,
			// `identify` + `email` are better-auth's defaults for Discord; no
			// explicit scope here or the list is emitted twice in the URL.
			prompt: 'consent'
		}
	},
	plugins: [
		admin({
			defaultRole: 'user'
		}),
		sveltekitCookies(getRequestEvent) // must be the last plugin in the array
	]
});
