import { fail } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { writeAudit, type DbTx } from '$lib/server/audit';
import { parseMicros } from '$lib/money';
import { requireCap } from '$lib/server/roles';
import { allowDevProviders } from '$lib/server/publish-env';
import { db } from '$lib/server/db';
import { model, pricingRule, provider, providerModel } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import {
	MODEL_STATUSES,
	cleanField,
	parseIntField,
	parseEnum,
	parseFlagsField,
	parseJsonField,
	parseSlugField,
	type ModelStatus
} from '$lib/server/admin-vocab';
import { reachability } from '$lib/publish';

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

/** 3-letter ISO currency code, defaulting to USD. */
function currencyField(raw: FormDataEntryValue | null | undefined): string | null {
	const text = String(raw ?? '').trim().toUpperCase();
	if (!text) return 'USD';
	return /^[A-Z]{3}$/.test(text) ? text : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.models');
	// The router's own flag: a `dev` provider is invisible when it is off, so the
	// console must not call a published model "live" in that case.
	const allowDev = allowDevProviders();
	const providers = await db
		.select({ id: provider.id, name: provider.name, status: provider.status })
		.from(provider)
		.orderBy(asc(provider.name));
	const models = await db
		.select({
			id: model.id,
			providerId: model.providerId,
			name: model.name,
			slug: model.slug,
			family: model.family,
			developer: model.developer,
			description: model.description,
			modality: model.modality,
			context: model.context,
			maxOutput: model.maxOutput,
			capabilities: model.capabilities,
			inputPrice: model.inputPrice,
			outputPrice: model.outputPrice,
			currency: model.currency,
			status: model.status
		})
		.from(model)
		.orderBy(asc(model.slug));
	// How many provider_model rows can serve each canonical model.
	const mappingCounts = await db
		.select({ modelId: providerModel.modelId, n: sql<number>`count(*)::int` })
		.from(providerModel)
		.groupBy(providerModel.modelId);
	const mappingsOf = new Map(mappingCounts.map((c) => [c.modelId, c.n]));
	// The versioned open rule wins over the legacy mirror columns — the same
	// precedence $lib/server/public-catalog shows to the world. Highest version
	// first, so the map entry kept is the current one.
	const openWideRules = await db
		.select({
			modelId: pricingRule.modelId,
			version: pricingRule.version,
			currency: pricingRule.currency,
			inputPrice: pricingRule.inputPrice,
			outputPrice: pricingRule.outputPrice
		})
		.from(pricingRule)
		.where(and(isNull(pricingRule.effectiveUntil), isNull(pricingRule.providerModelId)))
		.orderBy(desc(pricingRule.version));
	const effectiveOf = new Map(openWideRules.map((r) => [r.modelId, r]));
	const providerOf = new Map(providers.map((p) => [p.id, p]));
	const rows = models.map((m) => {
		const parent = providerOf.get(m.providerId);
		const reach = reachability(m.status, parent?.status ?? 'disabled', allowDev);
		const rule = effectiveOf.get(m.id);
		return {
			id: m.id,
			providerId: m.providerId,
			name: m.name,
			slug: m.slug,
			family: m.family,
			developer: m.developer,
			description: m.description,
			modality: m.modality,
			context: m.context,
			maxOutput: m.maxOutput,
			capabilities: m.capabilities,
			status: m.status,
			// Money: integer micros as text for `formatCost(BigInt(...))`. Shown
			// price is the effective one (open pricing rule, else legacy mirror).
			currency: rule?.currency ?? m.currency,
			inputPriceMicro: (rule ? micros(rule.inputPrice) : micros(m.inputPrice)).toString(),
			outputPriceMicro: (rule ? micros(rule.outputPrice) : micros(m.outputPrice)).toString(),
			mappingCount: mappingsOf.get(m.id) ?? 0,
			providerName: parent?.name ?? '—',
			providerStatus: parent?.status ?? '—',
			served: reach.served,
			hiddenReason: reach.reason
		};
	});
	// Per-provider roll-up. With a catalog this size the useful unit of work is a
	// whole provider, not one slug at a time — "unpublish all 237 InferHub rows"
	// should be one click.
	const summary = providers.map((p) => {
		const mine = rows.filter((r) => r.providerId === p.id);
		return {
			id: p.id,
			name: p.name,
			status: p.status,
			total: mine.length,
			published: mine.filter((r) => r.status === 'active').length,
			served: mine.filter((r) => r.served).length
		};
	});
	// Filters ride in the query string so a working view can be linked and kept
	// across the POST-redirect cycle.
	const providerFilter = url.searchParams.get('provider') ?? '';
	const stateFilter = url.searchParams.get('state') ?? 'all';
	const visible = rows.filter((r) => {
		if (providerFilter && r.providerId !== providerFilter) return false;
		if (stateFilter === 'served') return r.served;
		if (stateFilter === 'hidden') return !r.served;
		return true;
	});
	return {
		providers,
		models: visible,
		summary,
		providerFilter,
		stateFilter,
		allowDev,
		statuses: MODEL_STATUSES,
		counts: {
			all: rows.length,
			served: rows.filter((r) => r.served).length,
			hidden: rows.filter((r) => !r.served).length,
			published: rows.filter((r) => r.status === 'active').length
		}
	};
};

/**
 * Shared write path for the publish controls: the status write and its audit
 * rows share one transaction (PRD §71) — one audit entry per model, because
 * "which rows did that click touch" is per-resource history.
 */
async function setStatus(
	tx: DbTx,
	ids: string[],
	status: ModelStatus,
	actorUserId: string | null
): Promise<number> {
	const rows = await tx
		.select({ id: model.id, status: model.status })
		.from(model)
		.where(inArray(model.id, ids));
	for (const row of rows) {
		if (row.status === status) continue;
		await tx
			.update(model)
			.set({ status, updatedAt: new Date() })
			.where(eq(model.id, row.id));
		await writeAudit(tx, {
			actorUserId,
			action: 'model.status_set',
			resource: 'model',
			resourceId: row.id,
			before: { status: row.status },
			after: { status }
		});
	}
	return rows.length;
}

export const actions: Actions = {
	/**
	 * Set the publish flag on one row or many. A table row posts a single `ids`
	 * value; the checkbox toolbar posts one per selected row. Keeping both on one
	 * action means there is a single write path to reason about.
	 */
	bulk: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const status = parseEnum(MODEL_STATUSES, form.get('status'));
		const ids = [...new Set(form.getAll('ids').map((v) => String(v)).filter(Boolean))];
		if (!status) return fail(400, { error: 'Invalid status' });
		if (ids.length === 0) return fail(400, { error: 'Select at least one model' });
		const changed = await db.transaction(async (tx) =>
			setStatus(tx, ids, status, locals.user?.id ?? null)
		);
		if (changed === 0) return fail(404, { error: 'No matching models' });
		return { changed, message: `Status set to ${status} on ${changed} model(s).` };
	},
	/** Whole-provider switch — the practical control for a 200-row catalog. */
	provider: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		const status = parseEnum(MODEL_STATUSES, form.get('status'));
		if (!providerId) return fail(400, { error: 'Missing provider' });
		if (!status) return fail(400, { error: 'Invalid status' });
		const mine = await db
			.select({ id: model.id })
			.from(model)
			.where(eq(model.providerId, providerId));
		if (mine.length === 0) return fail(404, { error: 'That provider has no models' });
		const changed = await db.transaction(async (tx) =>
			setStatus(tx, mine.map((m) => m.id), status, locals.user?.id ?? null)
		);
		return { changed, message: `Status set to ${status} on ${changed} model(s).` };
	},
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		const name = cleanField(form.get('name'), 200);
		const slug = parseSlugField(form.get('slug'));
		const family = cleanField(form.get('family'), 120);
		const developer = cleanField(form.get('developer'), 200);
		const description = cleanField(form.get('description'), 2000);
		const modality = parseJsonField(form.get('modality'));
		const capabilities = parseFlagsField(form.get('capabilities'));
		const status = parseEnum(MODEL_STATUSES, form.get('status'));
		const currency = currencyField(form.get('currency'));
		const input = parseMicros(String(form.get('inputUsd') ?? ''));
		const output = parseMicros(String(form.get('outputUsd') ?? ''));
		const context = optionalInt(form.get('context'), 100_000_000);
		const maxOutput = optionalInt(form.get('maxOutput'), 100_000_000);
		// The mapping's upstream name defaults to the canonical slug (contract):
		// most providers call the model exactly what the catalog calls it.
		const providerModelRaw = String(form.get('providerModelId') ?? '').trim();
		const providerModelId = providerModelRaw ? parseSlugField(providerModelRaw) : slug;
		if (!providerModelId) return fail(400, { error: 'Upstream model id must be a slug' });
		if (!providerId || !name || !slug)
			return fail(400, { error: 'Provider, name and slug required' });
		if (!status) return fail(400, { error: 'Invalid status' });
		if (!currency) return fail(400, { error: 'Currency must be a 3-letter code' });
		if (modality === null || capabilities === null)
			return fail(400, { error: 'Modality/capabilities must be JSON objects' });
		if (!context.ok || !maxOutput.ok)
			return fail(400, { error: 'Context and max output must be positive integers' });
		if (input === null || output === null)
			return fail(400, { error: 'Prices must be non-negative USD per 1M tokens' });
		const [parent] = await db
			.select({ id: provider.id })
			.from(provider)
			.where(eq(provider.id, providerId))
			.limit(1);
		if (!parent) return fail(400, { error: 'Unknown provider' });
		const now = new Date();
		const modelId = newId(ID_PREFIXES.model);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(model).values({
					id: modelId,
					providerId,
					name,
					slug,
					family,
					developer,
					description,
					modality,
					capabilities,
					context: context.value,
					maxOutput: maxOutput.value,
					// Legacy columns kept working (contract item 13): the mirror prices
					// live here, the versioned truth in pricing_rule v1 below.
					inputPrice: input.toString(),
					outputPrice: output.toString(),
					currency,
					status
				});
				await tx.insert(providerModel).values({
					id: newId(ID_PREFIXES.providerModel),
					modelId,
					providerId,
					connectionId: null,
					providerModelId,
					enabled: true,
					capabilitiesOverride: {},
					contextOverride: null,
					status: 'available'
				});
				await tx.insert(pricingRule).values({
					id: newId(ID_PREFIXES.pricingRule),
					modelId,
					providerModelId: null,
					version: 1,
					currency,
					inputPrice: input.toString(),
					cachedInputPrice: null,
					outputPrice: output.toString(),
					reasoningPrice: null,
					effectiveFrom: now,
					effectiveUntil: null,
					createdBy: locals.user?.id ?? null
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'model.create',
					resource: 'model',
					resourceId: modelId,
					after: { name, slug, status, currency, context: context.value, maxOutput: maxOutput.value }
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'provider_model.create',
					resource: 'provider_model',
					resourceId: modelId,
					after: { modelId, providerId, providerModelId, enabled: true, status: 'available' }
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'pricing_rule.create',
					resource: 'pricing_rule',
					resourceId: modelId,
					after: {
						modelId,
						version: 1,
						currency,
						inputPrice: input.toString(),
						outputPrice: output.toString()
					}
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			// Unique index on model.slug — the most likely honest failure here.
			return fail(409, { error: `Could not create model: ${msg}` });
		}
		return { created: slug, message: `Model “${slug}” created with its first mapping and price v1.` };
	},
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
		const currency = currencyField(form.get('currency'));
		// Prices are NOT edited here: a price change is a new pricing_rule version
		// (PRD §60), so an edit can never rewrite what past bills resolved.
		const context = optionalInt(form.get('context'), 100_000_000);
		const maxOutput = optionalInt(form.get('maxOutput'), 100_000_000);
		if (!id) return fail(400, { error: 'Missing model id' });
		if (!name || !slug) return fail(400, { error: 'Name and slug required' });
		if (!status) return fail(400, { error: 'Invalid status' });
		if (!currency) return fail(400, { error: 'Currency must be a 3-letter code' });
		if (modality === null || capabilities === null)
			return fail(400, { error: 'Modality/capabilities must be JSON objects' });
		if (!context.ok || !maxOutput.ok)
			return fail(400, { error: 'Context and max output must be positive integers' });
		const [before] = await db
			.select()
			.from(model)
			.where(eq(model.id, id))
			.limit(1);
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
			currency,
			status
		};
		try {
			await db.transaction(async (tx) => {
				await tx
					.update(model)
					.set({ ...after, updatedAt: new Date() })
					.where(eq(model.id, id));
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
						currency: before.currency,
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
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing model id' });
		const [before] = await db
			.select()
			.from(model)
			.where(eq(model.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Model not found' });
		try {
			await db.transaction(async (tx) => {
				await tx.delete(model).where(eq(model.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'model.delete',
					resource: 'model',
					resourceId: id,
					before: {
						name: before.name,
						slug: before.slug,
						status: before.status,
						providerId: before.providerId
					}
				});
			});
		} catch {
			// request_log.model_id has no cascade: a referenced model is kept.
			return fail(409, { error: 'Model has request history — disable it instead' });
		}
		return { deleted: id, message: `Model “${before.slug}” deleted.` };
	}
};
