import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin } from 'better-auth/plugins';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { provisionWorkspace } from '$lib/server/provision';
import * as authSchema from '$lib/server/db/auth.schema';

const AUTH_ID_PREFIX: Record<string, string> = {
	user: ID_PREFIXES.user,
	session: ID_PREFIXES.session,
	account: ID_PREFIXES.account,
	verification: ID_PREFIXES.verification
};

export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
	// Better Auth mints its own rows; the platform wants prefixed public IDs (PRD
	// §81, spec §1). This maps the model name Better Auth passes to the platform
	// prefix, so a user created here carries the same `usr_…` shape as one wrapped
	// by the 0007 backfill — one ID grammar for every entity.
	advanced: {
		database: {
			generateId: ({ model }: { model: string }) => newId(AUTH_ID_PREFIX[model] ?? 'id_')
		}
	},
	// Fresh signup must end in workspace + default project + 3 environments +
	// billing account + owner membership (PRD §44). The hook covers every signup
	// path (email and Discord); `(app)/+layout.server.ts`'s ensureUserWorkspace
	// is the self-healing backstop for rows created any other way. A provisioning
	// failure here is loud — never a silent user-without-workspace state.
	databaseHooks: {
		user: {
			create: {
				after: async (created) => {
					await db.transaction(async (tx) => {
						await provisionWorkspace(tx, {
							name: `${created.name.split("'")[0]}'s Workspace`,
							ownerUserId: created.id
						});
					});
				}
			}
		}
	},
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
