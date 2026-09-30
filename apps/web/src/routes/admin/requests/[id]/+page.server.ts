import { eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import {
	apiKey,
	connection,
	model,
	provider,
	providerModel,
	requestAttempt,
	requestLog,
	user
} from '$lib/server/db/schema';
import { bodiesForDisplay } from '$lib/server/admin-retention';
import { getSetting } from '$lib/server/settings';

// Timing keys in PRD §29 order; the breakdown is jsonb, so render what exists.
const TIMING_KEYS = ['auth', 'rate_limit', 'routing', 'queue', 'connection', 'generation'] as const;

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.requests');
	const [row] = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			email: user.email,
			keyName: apiKey.name,
			keyPrefix: apiKey.prefix,
			workspaceId: requestLog.workspaceId,
			projectId: requestLog.projectId,
			environmentId: requestLog.environmentId,
			endpoint: requestLog.endpoint,
			requestedModel: requestLog.requestedModel,
			modelSlug: model.slug,
			providerModelEntityId: requestLog.providerModelId,
			upstreamModelId: providerModel.providerModelId,
			providerName: provider.name,
			connectionName: connection.name,
			credentialId: requestLog.credentialId,
			routingPolicyId: requestLog.routingPolicyId,
			strategy: requestLog.strategy,
			status: requestLog.status,
			errorCode: requestLog.errorCode,
			error: requestLog.error,
			httpStatus: requestLog.httpStatus,
			tokensIn: requestLog.tokensIn,
			cachedInputTokens: requestLog.cachedInputTokens,
			tokensOut: requestLog.tokensOut,
			reasoningTokens: requestLog.reasoningTokens,
			totalTokens: requestLog.totalTokens,
			inputPriceMicro: requestLog.inputPriceMicro,
			cachedInputPriceMicro: requestLog.cachedInputPriceMicro,
			outputPriceMicro: requestLog.outputPriceMicro,
			reasoningPriceMicro: requestLog.reasoningPriceMicro,
			pricingRuleId: requestLog.pricingRuleId,
			cost: requestLog.cost,
			currency: requestLog.currency,
			creditChargedMicro: requestLog.creditChargedMicro,
			providerCostMicro: requestLog.providerCostMicro,
			timing: requestLog.timing,
			ttftMs: requestLog.ttftMs,
			latencyMs: requestLog.latencyMs,
			attempts: requestLog.attempts,
			fallbackUsed: requestLog.fallbackUsed,
			stream: requestLog.stream,
			clientDisconnected: requestLog.clientDisconnected,
			requestBody: requestLog.requestBody,
			responseBody: requestLog.responseBody
		})
		.from(requestLog)
		.leftJoin(user, eq(user.id, requestLog.userId))
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(model, eq(model.id, requestLog.modelId))
		// request_log.provider_model_id carries the provider_model entity id (pmdl_…).
		.leftJoin(providerModel, eq(providerModel.id, requestLog.providerModelId))
		.leftJoin(provider, eq(provider.id, requestLog.providerId))
		.leftJoin(connection, eq(connection.id, requestLog.connectionId))
		.where(eq(requestLog.id, params.id))
		.limit(1);
	if (!row) error(404, 'Request not found');

	// Never touch the credential secret material — only the label (id) is shown.
	const attempts = await db
		.select({
			id: requestAttempt.id,
			attempt: requestAttempt.attempt,
			providerName: provider.name,
			connectionName: connection.name,
			credentialId: requestAttempt.credentialId,
			httpStatus: requestAttempt.httpStatus,
			errorCode: requestAttempt.errorCode,
			retryable: requestAttempt.retryable,
			latencyMs: requestAttempt.latencyMs,
			ttftMs: requestAttempt.ttftMs,
			providerCostMicro: requestAttempt.providerCostMicro,
			reason: requestAttempt.reason,
			startedAt: requestAttempt.startedAt,
			finishedAt: requestAttempt.finishedAt
		})
		.from(requestAttempt)
		.leftJoin(provider, eq(provider.id, requestAttempt.providerId))
		.leftJoin(connection, eq(connection.id, requestAttempt.connectionId))
		.where(eq(requestAttempt.requestId, row.id))
		.orderBy(requestAttempt.attempt);

	const retention = await getSetting('retention');
	// PRIVACY BOUNDARY (PRD §93-94): the ONLY body read on this page.
	const bodies = bodiesForDisplay(row, retention);

	const { requestBody: _rq, responseBody: _rs, ...detail } = row;

	return {
		detail,
		bodies,
		attempts,
		timing: TIMING_KEYS.map((key) => ({ key, ms: row.timing?.[key] ?? null }))
	};
};
