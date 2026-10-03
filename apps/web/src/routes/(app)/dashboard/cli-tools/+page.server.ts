import { error } from '@sveltejs/kit';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, model } from '$lib/server/db/schema';
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

	const models = await db
		.select({ slug: model.slug, name: model.name, developer: model.developer })
		.from(model)
		.where(ne(model.status, 'disabled'))
		.orderBy(model.slug);

	const keys = await db
		.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix })
		.from(apiKey)
		.where(
			and(
				eq(apiKey.userId, locals.user!.id),
				eq(apiKey.status, 'active'),
				isNull(apiKey.revokedAt)
			)
		)
		.orderBy(apiKey.createdAt);

	const baseUrl = (env.PUBLIC_API_BASE_URL || env.ROUTER_BASE_URL || 'http://127.0.0.1:8100').replace(
		/\/+$/,
		''
	);

	return { models, keys, baseUrl };
};
