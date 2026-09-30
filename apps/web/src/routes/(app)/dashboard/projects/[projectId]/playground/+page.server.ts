import { error, fail } from '@sveltejs/kit';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
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

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(403, 'No workspace selected');
	await requireMemberPermission(locals, workspaceId, 'key.create');
	const [proj] = await db
		.select({ id: project.id, name: project.name })
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	const models = await db
		.select({ id: model.id, slug: model.slug, name: model.name, status: model.status, developer: model.developer })
		.from(model)
		.where(ne(model.status, 'disabled'))
		.orderBy(model.slug);
	const aliases = await db
		.select({ id: modelAlias.id, name: modelAlias.name, description: modelAlias.description })
		.from(modelAlias)
		.where(
			or(
				eq(modelAlias.projectId, params.projectId),
				and(eq(modelAlias.workspaceId, workspaceId), isNull(modelAlias.projectId)),
				isNull(modelAlias.workspaceId)
			)
		)
		.orderBy(modelAlias.name);
	const keys = await db
		.select({ id: apiKey.id, name: apiKey.name })
		.from(apiKey)
		.where(
			and(
				eq(apiKey.userId, locals.user!.id),
				eq(apiKey.status, 'active'),
				isNull(apiKey.revokedAt),
				or(eq(apiKey.projectId, params.projectId), isNull(apiKey.projectId))
			)
		)
		.orderBy(apiKey.createdAt);
	return { project: proj, models, aliases, keys };
};

export const actions: Actions = {
	run: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) return fail(403, { error: 'No workspace selected' });
		await requireMemberPermission(locals, workspaceId, 'key.create');
		const form = await request.formData();
		const parsed = parsePlaygroundForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		if (parsed.value.stream) {
			return fail(400, { error: 'Streaming runs go through the stream endpoint.' });
		}
		const ctx = await resolveRunContext(locals, workspaceId, {
			keyId: parsed.value.keyId,
			projectId: params.projectId
		});
		if (!ctx) return fail(403, { error: 'Key not found in this workspace.' });

		const body = buildChatBody(parsed.value, { stream: false });
		const rawRequest = JSON.stringify(body, null, 2);
		// Body consumed inside the reclaim scope — see the global playground's
		// identical call for the `request_log` write-ordering reason.
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
		const log = await fetchRunMetrics(
			normalized.error?.requestId ?? normalized.metrics.requestId ?? ''
		);
		return {
			metrics: mergeLogMetrics(normalized.metrics, log),
			error: normalized.error,
			rawRequest,
			rawResponse: text,
			keyContext: ctx.sourceKeyName
		};
	}
};
