import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { model, project } from '$lib/server/db/schema';
import {
	SIM_STRATEGIES,
	simulateRouting,
	type SimInput,
	type SimResultRow,
	type SimStrategy
} from '$lib/server/admin-simulate';
import { PgSimStore } from '$lib/server/admin-sim-store';
import { parseIntField, parseEnum } from '$lib/server/admin-vocab';

/**
 * Routing simulation (PRD §64). `?/simulate` runs `simulateRouting` over the
 * `PgSimStore` — one read of configuration and health aggregates. The engine
 * performs NO inference and this module makes no network calls of any kind.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const models = await db
		.select({ id: model.id, name: model.name, slug: model.slug, status: model.status })
		.from(model)
		.orderBy(model.slug);
	const projects = await db
		.select({ id: project.id, name: project.name })
		.from(project)
		.orderBy(project.name);
	return {
		models,
		projects,
		strategies: SIM_STRATEGIES as readonly string[]
	};
};

/** Rows are rendered as plain data; bigint cost is stringified for the wire. */
interface SimRowView {
	providerName: string;
	connectionName: string | null;
	estimatedCostMicro: string;
	healthStatus: string;
	score: number;
	reason: string;
}

function toView(row: SimResultRow): SimRowView {
	return {
		providerName: row.providerName,
		connectionName: row.connectionName,
		estimatedCostMicro: row.estimatedCostMicro.toString(),
		healthStatus: row.healthStatus,
		score: row.score,
		reason: row.reason
	};
}

export const actions: Actions = {
	simulate: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const modelId = String(form.get('modelId') ?? '').trim();
		if (!modelId) return fail(400, { error: 'Pick a model' });
		const strategy = parseEnum(SIM_STRATEGIES as readonly string[], form.get('strategy'));
		if (!strategy) return fail(400, { error: 'Invalid strategy' });
		const inputTokens = parseIntField(form.get('inputTokens'), { min: 0, max: 10_000_000 });
		if (inputTokens === null) return fail(400, { error: 'input token estimate must be 0–10000000' });
		const outputTokens = parseIntField(form.get('outputTokens'), { min: 0, max: 10_000_000 });
		if (outputTokens === null) return fail(400, { error: 'output token estimate must be 0–10000000' });
		// Advanced weights: blank falls back to the engine's defaults.
		const weight = (raw: FormDataEntryValue | null): number | undefined => {
			const v = String(raw ?? '').trim();
			if (!v) return undefined;
			const n = Number(v);
			return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
		};
		const input: SimInput = {
			modelId,
			inputTokens,
			outputTokens,
			strategy: strategy as SimStrategy,
			weights: {
				price: weight(form.get('weightPrice')),
				latency: weight(form.get('weightLatency')),
				reliability: weight(form.get('weightReliability')),
				capacity: weight(form.get('weightCapacity'))
			}
		};
		// region / project are scenario labels only: the engine scores the
		// candidate set for the model as configured.
		const region = String(form.get('region') ?? '').trim().slice(0, 40) || null;
		const projectId = String(form.get('projectId') ?? '').trim().slice(0, 64) || null;
		const result = await simulateRouting(new PgSimStore(), input);
		return {
			simulated: true,
			strategy: result.strategy,
			candidatesConsidered: result.candidatesConsidered,
			region,
			projectId,
			rows: result.rows.map(toView)
		};
	}
};
