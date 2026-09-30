import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { getSetting } from '$lib/server/settings';
import { observeGate } from '$lib/server/observe/scope';
import { requestDetail, timingRows, TIMING_KEYS } from '$lib/server/observe/request-queries';
import {
	contentState,
	errorRetryable,
	normalizeStatus,
	statusTone,
	type ContentState
} from '$lib/server/observe/status';

/**
 * Request detail (PRD §29): metadata, model information, usage, billing,
 * timing, routing attempts and the error block. Raw prompt/response render ONLY
 * when `system_setting['retention']` allows content capture (PRD §93–94) —
 * otherwise the page states which retention state applies instead of a blank.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const gate = await observeGate(locals, params.projectId, 'request.read');
	if (gate.denied) return { denied: true, project: null, row: null, attempts: [], timing: [], content: null };

	const { row, attempts } = await requestDetail(db, gate.project.id, params.requestId);
	if (!row) return { denied: false, project: gate.project, row: null, attempts: [], timing: [], content: null };

	const retention = await getSetting('retention');
	const state = contentState(
		retention,
		{ requestBody: row.requestBody, responseBody: row.responseBody, createdAt: row.createdAt },
		new Date()
	);

	return {
		denied: false,
		projectId: gate.project.id,
		project: gate.project,
		row: {
			id: row.id,
			createdAt: row.createdAt,
			status: normalizeStatus(row.status),
			storedStatus: row.status,
			tone: statusTone(normalizeStatus(row.status)),
			endpoint: row.endpoint,
			projectName: row.projectName,
			environmentName: row.environmentName,
			keyName: row.keyName,
			keyPrefix: row.keyPrefix,
			clientIp: row.clientIp,
			userId: row.userId,
			workspaceId: row.workspaceId,
			// Model information (PRD §29): requested vs resolved, and who served it.
			requestedModel: row.requestedModel,
			resolvedSlug: row.resolvedSlug,
			providerName: row.providerName,
			providerId: row.providerId,
			providerModelName: row.providerModelName,
			connectionId: row.connectionId,
			strategy: row.strategy,
			routingPolicyId: row.routingPolicyId,
			// Usage (PRD §29).
			tokensIn: row.tokensIn,
			cachedInputTokens: row.cachedInputTokens,
			tokensOut: row.tokensOut,
			reasoningTokens: row.reasoningTokens,
			totalTokens: row.totalTokens ?? row.tokensIn + row.tokensOut,
			// Billing (PRD §29): provider cost / user cost / markup / credit charged.
			// Money crosses as strings — never a float.
			costMicro: row.cost.toString(),
			currency: row.currency,
			providerCostMicro: row.providerCostMicro?.toString() ?? null,
			markupMicro:
				row.providerCostMicro == null ? null : (row.cost - row.providerCostMicro).toString(),
			creditChargedMicro: row.creditChargedMicro?.toString() ?? null,
			pricingRuleId: row.pricingRuleId,
			inputPriceMicro: row.inputPriceMicro,
			cachedInputPriceMicro: row.cachedInputPriceMicro,
			outputPriceMicro: row.outputPriceMicro,
			reasoningPriceMicro: row.reasoningPriceMicro,
			// Timing + trace.
			ttftMs: row.ttftMs,
			latencyMs: row.latencyMs,
			attemptsCount: row.attempts,
			fallbackUsed: row.fallbackUsed,
			stream: row.stream,
			clientDisconnected: row.clientDisconnected,
			// Error block (PRD §29): normalized code + raw upstream text + HTTP.
			error: row.error,
			errorCode: row.errorCode,
			httpStatus: row.httpStatus,
			retryable: errorRetryable(row.errorCode, row.httpStatus)
		},
		// Timing (PRD §29 order): each stage from the timing jsonb; total is the
		// measured latency, TTFT is its own column. A missing stage is a `null`.
		timing: timingRows(row.timing, row.ttftMs, row.latencyMs),
		attempts: attempts.map((a) => ({
			id: a.id,
			attempt: a.attempt,
			providerName: a.providerName,
			providerId: a.providerId,
			connectionId: a.connectionId,
			httpStatus: a.httpStatus,
			errorCode: a.errorCode,
			retryable: a.retryable,
			latencyMs: a.latencyMs,
			ttftMs: a.ttftMs,
			providerCostMicro: a.providerCostMicro?.toString() ?? null,
			reason: a.reason,
			startedAt: a.startedAt,
			finishedAt: a.finishedAt
		})),
		// Raw prompt/response — only under content retention (PRD §93–94). The
		// bodies themselves leave this handler ONLY when the state is `shown`.
		content: contentPayload(state, row.requestBody, row.responseBody)
	};
};

type ContentPayload = { state: ContentState; requestBody: string | null; responseBody: string | null };
function contentPayload(state: ContentState, requestBody: string | null, responseBody: string | null): ContentPayload {
	if (state !== 'shown') return { state, requestBody: null, responseBody: null };
	return { state, requestBody, responseBody };
}
