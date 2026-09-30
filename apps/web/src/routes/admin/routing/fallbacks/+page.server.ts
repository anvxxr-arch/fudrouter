import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { routingPolicy } from '$lib/server/db/schema';

/**
 * Retry semantics (spec §9): retry on transient provider failures, never on
 * caller errors. Rendered as two badge columns per policy alongside its
 * retry posture (max_attempts / fallback_enabled).
 */
const RETRYABLE_CODES = [
	'RATE_LIMITED',
	'PROVIDER_TIMEOUT',
	'PROVIDER_UNAVAILABLE',
	'CIRCUIT_OPEN',
	'UPSTREAM_ERROR',
	'transport'
] as const;
const NEVER_RETRY_CODES = [
	'INVALID_REQUEST',
	'UNSUPPORTED_PARAMETER',
	'CONTEXT_TOO_LONG',
	'MODEL_NOT_FOUND',
	'AUTHORIZATION_ERROR',
	'CONTENT_REJECTED'
] as const;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const policies = await db
		.select({
			id: routingPolicy.id,
			name: routingPolicy.name,
			maxAttempts: routingPolicy.maxAttempts,
			fallbackEnabled: routingPolicy.fallbackEnabled,
			enabled: routingPolicy.enabled
		})
		.from(routingPolicy)
		.orderBy(routingPolicy.name);
	return { policies, retryable: RETRYABLE_CODES, neverRetry: NEVER_RETRY_CODES };
};
