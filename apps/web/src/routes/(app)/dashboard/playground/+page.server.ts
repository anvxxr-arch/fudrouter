import { error, fail } from '@sveltejs/kit';
import { and, eq, isNull, or, ne } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, model, modelAlias, project } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import {
	buildChatBody,
	mergeLogMetrics,
	normalizeRunResult,
	parsePlaygroundForm
} from '$lib/playground';
import {
	chatCompletionsRequest,
	fetchRunMetrics,
	resolveRunContext,
	withRunKey
} from '$lib/server/playground';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(403, 'No workspace selected');
	// The run path mints (and reclaims) a key, so the gate names that side effect.
	await requireMemberPermission(locals, workspaceId, 'key.create');
	const models = await db
		.select({
			id: model.id,
			slug: model.slug,
			name: model.name,
			status: model.status,
			developer: model.developer
		})
		.from(model)
		.where(ne(model.status, 'disabled'))
		.orderBy(model.slug);
	const aliases = await db
		.select({ id: modelAlias.id, name: modelAlias.name, description: modelAlias.description })
		.from(modelAlias)
		.where(
			or(
				isNull(modelAlias.workspaceId),
				and(eq(modelAlias.workspaceId, workspaceId), isNull(modelAlias.projectId))
			)
		)
		.orderBy(modelAlias.name);
	const keys = await db
		.select({ id: apiKey.id, name: apiKey.name })
		.from(apiKey)
		.where(and(eq(apiKey.userId, locals.user!.id), eq(apiKey.status, 'active'), isNull(apiKey.revokedAt)))
		.orderBy(apiKey.createdAt);
	return {
		models,
		// User-facing order: their own aliases first (project then workspace),
		// then the read-only global `fudrouter/*` virtuals at the bottom.
		aliases: aliases.filter((a) => !a.name.startsWith('fudrouter/')).concat(
			aliases.filter((a) => a.name.startsWith('fudrouter/'))
		),
		keys
	};
};

export const actions: Actions = {
	run: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) return fail(403, { error: 'No workspace selected' });
		await requireMemberPermission(locals, workspaceId, 'key.create');
		const form = await request.formData();
		const parsed = parsePlaygroundForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		// Streaming runs go through /api/playground/stream (SSE cannot ride a form
		// action's JSON response); this action rejects them instead of buffering.
		if (parsed.value.stream) {
			return fail(400, { error: 'Streaming runs go through the stream endpoint.' });
		}
		const ctx = await resolveRunContext(locals, workspaceId, {
			keyId: parsed.value.keyId,
			projectId: String(form.get('projectId') ?? '') || undefined
		});
		if (!ctx) return fail(403, { error: 'Key not found in this workspace.' });

		const body = buildChatBody(parsed.value, { stream: false });
		const rawRequest = JSON.stringify(body, null, 2);
		// The body must be consumed INSIDE the reclaim scope: the data plane
		// writes `request_log` only after the response body ends, so a `finally`
		// that ran on `fetch()` resolution (headers) would delete the run key
		// first and the ledger row would land with `api_key_id = NULL` — the
		// metrics lookup below then finds nothing and every run shows `—`.
		const { status, headers, text } = await withRunKey(locals, ctx, async (key) => {
			const res = await chatCompletionsRequest(key, body, parsed.value.strategy || null);
			return { status: res.status, headers: res.headers, text: await res.text() };
		});
		let json: Record<string, unknown> | null = null;
		try {
			json = JSON.parse(text) as Record<string, unknown>;
		} catch {
			json = null;
		}
		const normalized = normalizeRunResult({ status, headers, json, text });
		const log = await fetchRunMetrics(normalized.error?.requestId ?? normalized.metrics.requestId ?? '');
		return {
			metrics: mergeLogMetrics(normalized.metrics, log),
			error: normalized.error,
			rawRequest,
			rawResponse: text,
			keyContext: ctx.sourceKeyName
		};
	}
};
