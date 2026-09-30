import { type Actions } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey } from '$lib/server/db/schema';
import { servedModels } from '$lib/server/public-catalog';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import {
	buildChatBody,
	mergeLogMetrics,
	normalizeRunResult,
	parsePlaygroundForm,
	type NormalizedError,
	type RunMetrics
} from '$lib/playground';
import {
	chatCompletionsRequest,
	fetchRunMetrics,
	resolveRunContext,
	withRunKey
} from '$lib/server/playground';
/**
 * The PUBLIC playground (PRD §18). Anonymous visitors get the full form as a
 * demo and no request ever leaves the server — the action below refuses before
 * it touches the database. Signed-in members run a REAL request through the
 * same /v1/chat/completions path their key uses, under a short-lived run key
 * (all five mint rules live in $lib/server/playground; `withRunKey` reclaims in
 * a finally).
 *
 * The action path is non-streaming only: SSE runs go through /playground/run
 * because a form action cannot deliver bytes incrementally.
 */
export interface PlaygroundRunResult {
	response: string | null;
	metrics: RunMetrics | null;
	error: NormalizedError | null;
	keyContext: string | null;
}
// One shape for every outcome — a failed run is data this page renders, not a
// crash. `denial` is the permission-denied answer (PRD §108/§130).
const denial = (message: string): PlaygroundRunResult => ({
	response: null,
	metrics: null,
	error: { code: 'AUTHORIZATION_ERROR', message, requestId: null },
	keyContext: null
});
export const load: PageServerLoad = async ({ locals }) => {
	// The model select lists exactly what the router would serve. No key, no
	// workspace, no problem: the demo state needs the list too.
	const models = await servedModels();
	const keys = locals.user
		? await db
				.select({ id: apiKey.id, name: apiKey.name })
				.from(apiKey)
				.where(and(eq(apiKey.userId, locals.user.id), eq(apiKey.status, 'active'), isNull(apiKey.revokedAt)))
				.orderBy(apiKey.createdAt)
		: [];
	return {
		models: models.map(({ slug, name }) => ({ slug, name })),
		keys
	};
};
export const actions: Actions = {
	default: async ({ locals, request }) => {
		// Anonymous: the demo runs nothing. This is also the denied state.
		if (!locals.user) return denial('Running a request needs an account. Sign up for an API key first.');
		const form = await request.formData();
		const parsed = parsePlaygroundForm((k) => form.get(k));
		if (!parsed.ok) {
			return {
				response: null,
				metrics: null,
				error: { code: 'INVALID_REQUEST', message: parsed.error, requestId: null },
				keyContext: null
			} satisfies PlaygroundRunResult;
		}
		if (parsed.value.stream) {
			// The page routes checked streams to /playground/run; a stream that
			// lands here (JS off) must not be silently buffered into a lie.
			return {
				response: null,
				metrics: null,
				error: {
					code: 'INVALID_REQUEST',
					message: 'Streaming runs are relayed at /playground/run — uncheck streaming or enable JavaScript.',
					requestId: null
				},
				keyContext: null
			} satisfies PlaygroundRunResult;
		}
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) return denial('No workspace is available to this account yet.');
		// The run mints (and reclaims) a key, so the permission names that side
		// effect. Missing permission throws 403 with the PRD §130 answers.
		await requireMemberPermission(locals, workspaceId, 'key.create');
		const ctx = await resolveRunContext(locals, workspaceId, { keyId: parsed.value.keyId });
		if (!ctx) return denial('That API key is not in this workspace.');
		const body = buildChatBody(parsed.value, { stream: false });
		try {
			const result = await withRunKey(locals, ctx, (key) =>
				chatCompletionsRequest(key, body, parsed.value.strategy || null)
			);
			const text = await result.text();
			let json: Record<string, unknown> | null = null;
			try {
				json = JSON.parse(text) as Record<string, unknown>;
			} catch {
				json = null;
			}
			const normalized = normalizeRunResult({ status: result.status, headers: result.headers, json, text });
			const log = await fetchRunMetrics(normalized.error?.requestId ?? normalized.metrics.requestId ?? '');
			// The completion text when there is one; the raw body when the shape
			// has no content field (never a guess at "what the model said").
			const choices = (json?.choices ?? null) as { message?: { content?: unknown } }[] | null;
			const content = choices?.[0]?.message?.content;
			return {
				response: typeof content === 'string' ? content : text,
				metrics: mergeLogMetrics(normalized.metrics, log),
				error: normalized.error,
				keyContext: ctx.sourceKeyName
			};
		} catch (e) {
			return {
				response: null,
				metrics: null,
				error: {
					code: 'UPSTREAM_ERROR',
					message: e instanceof Error ? e.message.slice(0, 500) : 'The run failed to reach the router.',
					requestId: null
				},
				keyContext: ctx.sourceKeyName
			};
		}
	}
};
