import { error, fail } from '@sveltejs/kit';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import {
	connection,
	model,
	pricingRule,
	provider,
	providerModel,
	requestLog
} from '$lib/server/db/schema';
import {
	MODEL_STATUSES,
	PROVIDER_MODEL_STATUSES,
	cleanField,
	parseIntField,
	parseBoolField,
	parseEnum,
	parseFlagsField,
	parseJsonField,
	parseSlugField
} from '$lib/server/admin-vocab';
import { microsToInput } from '$lib/money';

/**
 * numeric(18,6) money columns are micro-units with 6 digits of SCALE PADDING —
 * '2000000.000000' is 2_000_000 micros. Money never touches a float here: the
 * integer part is the micro count and the padding is dropped as text.
 */
function micros(value: string | null | undefined): bigint {
	const [whole = '0'] = String(value ?? '0').split('.');
	return BigInt(whole);
}

/** Empty clears an optional integer column; anything else must parse. */
function optionalInt(
	raw: FormDataEntryValue | null | undefined,
	max: number
): { ok: true; value: number | null } | { ok: false } {
	const text = String(raw ?? '').trim();
	if (!text) return { ok: true, value: null };
	const value = parseIntField(text, { min: 1, max });
	return value === null ? { ok: false } : { ok: true, value };
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.models');
	const id = String(params.id ?? '');
	const [m] = await db.select().from(model).where(eq(model.id, id)).limit(1);
	if (!m) error(404, 'Model not found');

	// The provider_model mappings that can serve this canonical model.
	const mappings = await db
		.select({
			id: providerModel.id,
			providerId: providerModel.providerId,
			connectionId: providerModel.connectionId,
			providerModelId: providerModel.providerModelId,
			enabled: providerModel.enabled,
			capabilitiesOverride: providerModel.capabilitiesOverride,
			contextOverride: providerModel.contextOverride,
			status: providerModel.status,
			providerName: provider.name,
			connectionName: connection.name
		})
		.from(providerModel)
		.innerJoin(provider, eq(provider.id, providerModel.providerId))
		.leftJoin(connection, eq(connection.id, providerModel.connectionId))
		.where(eq(providerModel.modelId, id))
		.orderBy(asc(provider.name), asc(providerModel.providerModelId));
	const mappingById = new Map(mappings.map((row) => [row.id, row]));

	// Pricing history — current (open) rows and closed ones, versioned per
	// (model_id, coalesce(provider_model_id,'')) key. `pricing_rule.provider_model_id`
	// carries the mapping's PK (see $lib/server/public-catalog).
	const rules = await db
		.select({
			id: pricingRule.id,
			providerModelId: pricingRule.providerModelId,
			version: pricingRule.version,
			currency: pricingRule.currency,
			inputPrice: pricingRule.inputPrice,
			cachedInputPrice: pricingRule.cachedInputPrice,
			outputPrice: pricingRule.outputPrice,
			reasoningPrice: pricingRule.reasoningPrice,
			effectiveFrom: pricingRule.effectiveFrom,
			effectiveUntil: pricingRule.effectiveUntil,
			createdBy: pricingRule.createdBy,
			createdAt: pricingRule.createdAt
		})
		.from(pricingRule)
		.where(eq(pricingRule.modelId, id))
		.orderBy(asc(pricingRule.providerModelId), desc(pricingRule.version));
	const pricing = rules.map((r) => {
		const mapping = r.providerModelId ? mappingById.get(r.providerModelId) : null;
		return {
			id: r.id,
			scope: r.providerModelId ? (mapping?.providerModelId ?? '(removed mapping)') : 'model-wide',
			version: r.version,
			currency: r.currency,
			inputPriceMicro: micros(r.inputPrice).toString(),
			cachedInputPriceMicro:
				r.cachedInputPrice === null ? null : micros(r.cachedInputPrice).toString(),
			outputPriceMicro: micros(r.outputPrice).toString(),
			reasoningPriceMicro: r.reasoningPrice === null ? null : micros(r.reasoningPrice).toString(),
			effectiveFrom: r.effectiveFrom.toISOString(),
			effectiveUntil: r.effectiveUntil ? r.effectiveUntil.toISOString() : null,
			current: r.effectiveUntil === null,
			createdBy: r.createdBy,
			createdAt: r.createdAt.toISOString()
		};
	});

	// Request volume and cost. `request_log` is the only place a call is
	// recorded, so every number here is an observed fact.
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`,
			avgLatency: sql<number>`coalesce(round(avg(${requestLog.latencyMs})), 0)::int`
		})
		.from(requestLog)
		.where(eq(requestLog.modelId, id));
	const [day] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(
			and(
				eq(requestLog.modelId, id),
				sql`${requestLog.createdAt} > now() - interval '24 hours'`
			)
		);
	const dayExpr = sql`date_trunc('day', ${requestLog.createdAt})`;
	const perDay = await db
		.select({
			day: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`,
			requests: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(
			and(
				eq(requestLog.modelId, id),
				sql`${requestLog.createdAt} > now() - interval '14 days'`
			)
		)
		.groupBy(dayExpr)
		.orderBy(desc(dayExpr));

	return {
		model: {
			id: m.id,
			name: m.name,
			slug: m.slug,
			family: m.family,
			developer: m.developer,
			description: m.description,
			modality: m.modality,
			context: m.context,
			maxOutput: m.maxOutput,
			capabilities: m.capabilities,
			currency: m.currency,
			status: m.status,
			// The legacy mirror columns (contract item 13) shown read-only; the
			// versioned truth is the pricing history below.
			inputUsd: microsToInput(micros(m.inputPrice)),
			outputUsd: microsToInput(micros(m.outputPrice)),
			createdAt: m.createdAt.toISOString(),
			updatedAt: m.updatedAt.toISOString()
		},
		mappings: mappings.map((row) => ({
			...row,
			context: row.contextOverride ?? m.context
		})),
		pricing,
		usage: {
			totals: { ...totals, cost: totals.cost },
			day,
			perDay,
			currency: m.currency
		},
		statuses: MODEL_STATUSES,
		mappingStatuses: PROVIDER_MODEL_STATUSES
	};
};

export const actions: Actions = {
	/** Canonical fields. Prices are not edited here — they version on the pricing page. */
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = cleanField(form.get('name'), 200);
		const slug = parseSlugField(form.get('slug'));
		const family = cleanField(form.get('family'), 120);
		const developer = cleanField(form.get('developer'), 200);
		const description = cleanField(form.get('description'), 2000);
		const modality = parseJsonField(form.get('modality'));
		const capabilities = parseFlagsField(form.get('capabilities'));
		const status = parseEnum(MODEL_STATUSES, form.get('status'));
		const context = optionalInt(form.get('context'), 100_000_000);
		const maxOutput = optionalInt(form.get('maxOutput'), 100_000_000);
		if (!id) return fail(400, { error: 'Missing model id' });
		if (!name || !slug) return fail(400, { error: 'Name and slug required' });
		if (!status) return fail(400, { error: 'Invalid status' });
		if (modality === null || capabilities === null)
			return fail(400, { error: 'Modality/capabilities must be JSON objects' });
		if (!context.ok || !maxOutput.ok)
			return fail(400, { error: 'Context and max output must be positive integers' });
		const [before] = await db.select().from(model).where(eq(model.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Model not found' });
		const after = {
			name,
			slug,
			family,
			developer,
			description,
			modality,
			capabilities,
			context: context.value,
			maxOutput: maxOutput.value,
			status
		};
		try {
			await db.transaction(async (tx) => {
				await tx.update(model).set({ ...after, updatedAt: new Date() }).where(eq(model.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'model.update',
					resource: 'model',
					resourceId: id,
					before: {
						name: before.name,
						slug: before.slug,
						family: before.family,
						developer: before.developer,
						description: before.description,
						modality: before.modality,
						capabilities: before.capabilities,
						context: before.context,
						maxOutput: before.maxOutput,
						status: before.status
					},
					after
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'update failed';
			return fail(409, { error: `Could not update model: ${msg}` });
		}
		return { updated: id, message: `Model “${slug}” saved.` };
	},
	/**
	 * Per-mapping control: enable/disable and status. The upstream name and the
	 * overrides live on the mappings page; this is the routable-candidate switch.
	 */
	mapping: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const enabled = parseBoolField(form.get('enabled'));
		const status = parseEnum(PROVIDER_MODEL_STATUSES, form.get('status'));
		if (!id) return fail(400, { error: 'Missing mapping id' });
		if (!status) return fail(400, { error: 'Invalid status' });
		const [before] = await db
			.select()
			.from(providerModel)
			.where(eq(providerModel.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Mapping not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(providerModel)
				.set({ enabled, status, updatedAt: new Date() })
				.where(eq(providerModel.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'provider_model.update',
				resource: 'provider_model',
				resourceId: id,
				before: { enabled: before.enabled, status: before.status },
				after: { enabled, status }
			});
		});
		return { mappingUpdated: id, message: 'Mapping saved.' };
	}
};
