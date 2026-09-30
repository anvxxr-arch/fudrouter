import { fail } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { writeAudit } from '$lib/server/audit';
import { microsToInput, parseMicros } from '$lib/money';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { model, pricingRule, providerModel } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';

/**
 * numeric(18,6) money columns are micro-units with 6 digits of SCALE PADDING —
 * '2000000.000000' is 2_000_000 micros. Money never touches a float here: the
 * integer part is the micro count and the padding is dropped as text.
 */
function micros(value: string | null | undefined): bigint {
	const [whole = '0'] = String(value ?? '0').split('.');
	return BigInt(whole);
}

/** numeric(18,6) holds up to 12 integer digits of micros. */
const MAX_MICROS = 999_999_999_999_999n;

/**
 * One price field: empty means zero (the row stores a value, the fallback
 * semantics are for the NULL cached/reasoning columns only), otherwise an exact
 * decimal-string parse into integer micros.
 */
function priceField(raw: FormDataEntryValue | null | undefined): { ok: true; value: string } | { ok: false } {
	const text = String(raw ?? '').trim();
	if (!text) return { ok: true, value: '0' };
	const value = parseMicros(text);
	if (value === null || value > MAX_MICROS) return { ok: false };
	return { ok: true, value: value.toString() };
}

/** Optional price: empty means NULL — "falls back to input/output". */
function optionalPrice(
	raw: FormDataEntryValue | null | undefined
): { ok: true; value: string | null } | { ok: false } {
	const text = String(raw ?? '').trim();
	if (!text) return { ok: true, value: null };
	const value = parseMicros(text);
	if (value === null || value > MAX_MICROS) return { ok: false };
	return { ok: true, value: value.toString() };
}

function currencyField(raw: FormDataEntryValue | null | undefined): string | null {
	const text = String(raw ?? '').trim().toUpperCase();
	if (!text) return 'USD';
	return /^[A-Z]{3}$/.test(text) ? text : null;
}

/** `YYYY-MM-DD` → midnight UTC, full ISO passes through, empty means now. */
function effectiveFromField(
	raw: FormDataEntryValue | null | undefined
): { ok: true; value: Date } | { ok: false } {
	const text = String(raw ?? '').trim();
	if (!text) return { ok: true, value: new Date() };
	const value = /^\d{4}-\d{2}-\d{2}$/.test(text)
		? new Date(`${text}T00:00:00Z`)
		: new Date(text);
	return Number.isNaN(value.getTime()) ? { ok: false } : { ok: true, value };
}

interface RuleRow {
	id: string;
	modelId: string;
	providerModelId: string | null;
	version: number;
	currency: string;
	inputPrice: string;
	cachedInputPrice: string | null;
	outputPrice: string;
	reasoningPrice: string | null;
	effectiveFrom: Date;
	effectiveUntil: Date | null;
	createdBy: string | null;
	createdAt: Date;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.models');
	const modelFilter = url.searchParams.get('model') ?? '';
	const rows = await db
		.select({
			id: pricingRule.id,
			modelId: pricingRule.modelId,
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
			createdAt: pricingRule.createdAt,
			modelSlug: model.slug,
			mappingUpstream: providerModel.providerModelId
		})
		.from(pricingRule)
		.innerJoin(model, eq(model.id, pricingRule.modelId))
		.leftJoin(providerModel, eq(providerModel.id, pricingRule.providerModelId))
		.orderBy(asc(model.slug), asc(pricingRule.providerModelId), desc(pricingRule.version));
	const rules = rows.map((r) => ({
		id: r.id,
		modelId: r.modelId,
		providerModelId: r.providerModelId,
		scope: r.providerModelId ? (r.mappingUpstream ?? '(removed mapping)') : 'model-wide',
		modelSlug: r.modelSlug,
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
	}));
	const models = await db
		.select({ id: model.id, slug: model.slug })
		.from(model)
		.orderBy(asc(model.slug));
	const mappings = await db
		.select({
			id: providerModel.id,
			modelId: providerModel.modelId,
			upstream: providerModel.providerModelId
		})
		.from(providerModel)
		.orderBy(asc(providerModel.providerModelId));
	return {
		models,
		mappings,
		rules: modelFilter ? rules.filter((r) => r.modelId === modelFilter) : rules,
		modelFilter
	};
};

/**
 * Shared by preview and apply: parse the proposal and compute the version row
 * `apply` would insert. `preview` returns it; `apply` writes exactly it — the
 * two can never drift apart.
 */
function parseProposal(form: FormData): {
	error: string;
} | {
	modelId: string;
	providerModelId: string | null;
	currency: string;
	inputPrice: string;
	cachedInputPrice: string | null;
	outputPrice: string;
	reasoningPrice: string | null;
	effectiveFrom: Date;
} {
	const modelId = String(form.get('modelId') ?? '').trim();
	const providerModelRaw = String(form.get('providerModelId') ?? '').trim();
	const currency = currencyField(form.get('currency'));
	const input = priceField(form.get('inputPrice'));
	const cached = optionalPrice(form.get('cachedInputPrice'));
	const output = priceField(form.get('outputPrice'));
	const reasoning = optionalPrice(form.get('reasoningPrice'));
	const effectiveFrom = effectiveFromField(form.get('effectiveFrom'));
	if (!modelId) return { error: 'Missing model' };
	if (!currency) return { error: 'Currency must be a 3-letter code' };
	if (!input.ok || !cached.ok || !output.ok || !reasoning.ok)
		return { error: 'Prices must be non-negative decimal USD per 1M tokens' };
	if (!effectiveFrom.ok) return { error: 'Effective from must be a YYYY-MM-DD date' };
	return {
		modelId,
		providerModelId: providerModelRaw ? providerModelRaw : null,
		currency,
		inputPrice: input.value,
		cachedInputPrice: cached.value,
		outputPrice: output.value,
		reasoningPrice: reasoning.value,
		effectiveFrom: effectiveFrom.value
	};
}

/** The current open row and the highest version number for a pricing key. */
async function stateOf(modelId: string, providerModelId: string | null): Promise<{
	current: RuleRow | null;
	nextVersion: number;
}> {
	const rows = await db
		.select()
		.from(pricingRule)
		.where(
			and(
				eq(pricingRule.modelId, modelId),
				providerModelId === null
					? isNull(pricingRule.providerModelId)
					: eq(pricingRule.providerModelId, providerModelId)
			)
		)
		.orderBy(desc(pricingRule.version));
	const current = rows.find((r) => r.effectiveUntil === null) ?? rows[0] ?? null;
	return { current, nextVersion: (rows[0]?.version ?? 0) + 1 };
}

export const actions: Actions = {
	/**
	 * Compute the next version row and a price diff. NOTHING is written — this
	 * is the "what would happen" step the operator reads before approving.
	 */
	preview: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const proposal = parseProposal(form);
		if ('error' in proposal) return fail(400, { error: proposal.error });
		const [m] = await db
			.select({ id: model.id, slug: model.slug })
			.from(model)
			.where(eq(model.id, proposal.modelId))
			.limit(1);
		if (!m) return fail(404, { error: 'Model not found' });
		let scope = 'model-wide';
		if (proposal.providerModelId) {
			const [mapping] = await db
				.select({ id: providerModel.id, upstream: providerModel.providerModelId })
				.from(providerModel)
				.where(eq(providerModel.id, proposal.providerModelId))
				.limit(1);
			if (!mapping) return fail(400, { error: 'Unknown mapping' });
			scope = mapping.upstream;
		}
		const { current, nextVersion } = await stateOf(proposal.modelId, proposal.providerModelId);
		const fields: {
			key: string;
			label: string;
			before: string | null;
			after: string | null;
			/** Exact decimal re-submission value for the apply form (no float round-trip). */
			afterUsd: string | null;
		}[] = [
			{
				key: 'inputPrice',
				label: 'Input',
				before: current ? micros(current.inputPrice).toString() : null,
				after: proposal.inputPrice,
				afterUsd: microsToInput(BigInt(proposal.inputPrice))
			},
			{
				key: 'cachedInputPrice',
				label: 'Cached input',
				before: current?.cachedInputPrice == null ? null : micros(current.cachedInputPrice).toString(),
				after: proposal.cachedInputPrice,
				afterUsd:
					proposal.cachedInputPrice === null
						? null
						: microsToInput(BigInt(proposal.cachedInputPrice))
			},
			{
				key: 'outputPrice',
				label: 'Output',
				before: current ? micros(current.outputPrice).toString() : null,
				after: proposal.outputPrice,
				afterUsd: microsToInput(BigInt(proposal.outputPrice))
			},
			{
				key: 'reasoningPrice',
				label: 'Reasoning',
				before: current?.reasoningPrice == null ? null : micros(current.reasoningPrice).toString(),
				after: proposal.reasoningPrice,
				afterUsd:
					proposal.reasoningPrice === null
						? null
						: microsToInput(BigInt(proposal.reasoningPrice))
			}
		];
		return {
			preview: {
				modelId: proposal.modelId,
				modelSlug: m.slug,
				providerModelId: proposal.providerModelId,
				scope,
				currency: proposal.currency,
				effectiveFrom: proposal.effectiveFrom.toISOString(),
				version: nextVersion,
				old: current
					? {
							version: current.version,
							effectiveFrom: current.effectiveFrom.toISOString(),
							effectiveUntil: current.effectiveUntil ? current.effectiveUntil.toISOString() : null
						}
					: null,
				diff: fields.map((f) => ({ ...f, changed: f.before !== f.after }))
			}
		};
	},
	/**
	 * Apply the proposal as a NEW version row. History is never mutated: the
	 * only UPDATE is `effective_until` on the open row (never a price column),
	 * then the next version is inserted — both in one transaction with the audit
	 * entry (PRD §71).
	 */
	apply: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		// Applying is the consequential step: the approval box is a hard gate.
		if (String(form.get('approved') ?? '').trim() !== 'on')
			return fail(400, { error: 'Tick “approved” to apply a new price version' });
		const proposal = parseProposal(form);
		if ('error' in proposal) return fail(400, { error: proposal.error });
		const [m] = await db
			.select({ id: model.id, slug: model.slug })
			.from(model)
			.where(eq(model.id, proposal.modelId))
			.limit(1);
		if (!m) return fail(404, { error: 'Model not found' });
		if (proposal.providerModelId) {
			const [mapping] = await db
				.select({ id: providerModel.id })
				.from(providerModel)
				.where(eq(providerModel.id, proposal.providerModelId))
				.limit(1);
			if (!mapping) return fail(400, { error: 'Unknown mapping' });
		}
		const now = new Date();
		const { current, nextVersion } = await stateOf(proposal.modelId, proposal.providerModelId);
		const id = newId(ID_PREFIXES.pricingRule);
		try {
			await db.transaction(async (tx) => {
				// Close the open row. NEVER an update of a price column — the old
				// values stay byte-identical so past bills remain reproducible.
				// A row that is already closed keeps its effective_until forever.
				if (current && current.effectiveUntil === null) {
					await tx
						.update(pricingRule)
						.set({ effectiveUntil: now })
						.where(eq(pricingRule.id, current.id));
				}
				await tx.insert(pricingRule).values({
					id,
					modelId: proposal.modelId,
					providerModelId: proposal.providerModelId,
					version: nextVersion,
					currency: proposal.currency,
					inputPrice: proposal.inputPrice,
					cachedInputPrice: proposal.cachedInputPrice,
					outputPrice: proposal.outputPrice,
					reasoningPrice: proposal.reasoningPrice,
					effectiveFrom: proposal.effectiveFrom,
					effectiveUntil: null,
					createdBy: locals.user?.id ?? null
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'pricing_rule.apply',
					resource: 'pricing_rule',
					resourceId: id,
					before: current
						? {
								version: current.version,
								inputPrice: micros(current.inputPrice).toString(),
								cachedInputPrice:
									current.cachedInputPrice == null ? null : micros(current.cachedInputPrice).toString(),
								outputPrice: micros(current.outputPrice).toString(),
								reasoningPrice:
									current.reasoningPrice == null ? null : micros(current.reasoningPrice).toString(),
								closedAt: now.toISOString()
							}
						: null,
					after: {
						modelId: proposal.modelId,
						providerModelId: proposal.providerModelId,
						version: nextVersion,
						currency: proposal.currency,
						inputPrice: proposal.inputPrice,
						cachedInputPrice: proposal.cachedInputPrice,
						outputPrice: proposal.outputPrice,
						reasoningPrice: proposal.reasoningPrice,
						effectiveFrom: proposal.effectiveFrom.toISOString()
					}
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(409, { error: `Could not apply price version: ${msg}` });
		}
		return {
			applied: id,
			message: `Pricing v${nextVersion} applied to ${m.slug} — v${current?.version ?? 0} closed, v${nextVersion} inserted.`
		};
	}
};
