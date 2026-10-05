import { error } from '@sveltejs/kit';
import { and, eq, isNull, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, modelAlias } from '$lib/server/db/schema';
import { servedModels } from '$lib/server/public-catalog';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId } from '$lib/server/rbac';

/**
 * The client-onboarding page (read-only).
 *
 * It resolves the three values a snippet needs — the PUBLIC router base URL, the
 * published model slugs, and the user's own key prefixes — and hands them to the
 * page, which renders the per-tool config from `$lib/cli-tools`. Nothing here
 * mints, mutates or bills; the only capability it needs is `member`.
 *
 * The base URL is `PUBLIC_API_BASE_URL` when set (the deployment's public
 * origin) and falls back to `ROUTER_BASE_URL`, so a local run prints a working
 * localhost snippet instead of a production host.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(403, 'No workspace selected');

	// The picker must offer exactly what the data plane serves. Reuse the public
	// catalog's publish gate rather than a loose status filter, or the page
	// advertises slugs that answer 404 at the router.
	const models = (await servedModels()).map((m) => ({
		slug: m.slug,
		name: m.name,
		developer: m.developer
	}));

	// Identifiers a client may send besides a canonical slug. The router resolves
	// project → workspace → global aliases, then the `fudrouter/*` virtuals, so
	// the picker offers the same names or it under-promises what the API accepts.
	// Scope mirrors the router: a global row (workspace null) or a workspace-level
	// one (project null). A project alias needs a project the page does not have.
	const aliases = await db
		.select({ name: modelAlias.name, description: modelAlias.description })
		.from(modelAlias)
		.where(
			and(
				eq(modelAlias.enabled, true),
				or(
					isNull(modelAlias.workspaceId),
					and(eq(modelAlias.workspaceId, workspaceId), isNull(modelAlias.projectId))
				)
			)
		)
		.orderBy(modelAlias.name);

	const keys = await db
		.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix })
		.from(apiKey)
		.where(
			and(eq(apiKey.userId, locals.user!.id), eq(apiKey.status, 'active'), isNull(apiKey.revokedAt))
		)
		.orderBy(apiKey.createdAt);

	const baseUrl = (
		env.PUBLIC_API_BASE_URL ||
		env.ROUTER_BASE_URL ||
		'http://127.0.0.1:8100'
	).replace(/\/+$/, '');

	// User-facing order: their own aliases first, then the read-only global
	// `fudrouter/*` virtuals at the bottom — the same order the playground uses.
	return {
		models,
		aliases: aliases
			.filter((a) => !a.name.startsWith('fudrouter/'))
			.concat(aliases.filter((a) => a.name.startsWith('fudrouter/'))),
		keys,
		baseUrl
	};
};
