import { fail } from '@sveltejs/kit';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { writeAudit } from '$lib/server/audit';
import { decryptCredentials, type Credentials } from '$lib/server/credentials';
import { parseMicros } from '$lib/money';
import { requireCap } from '$lib/server/roles';
import { allowPrivateUpstreams } from '$lib/server/publish-env';
import { assertPublicUpstream } from '$lib/server/ssrf';
import { fetchUpstreamCatalog } from '$lib/server/provider-catalog-fetch';
import { db } from '$lib/server/db';
import {
	connection,
	credential,
	model,
	pricingRule,
	provider,
	providerModel
} from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { parseIntField, parseSlugField } from '$lib/server/admin-vocab';
import { matchKey, type UpstreamModel } from '$lib/provider-catalog';

/** numeric(18,6) holds up to 12 integer digits of micros. */
const MAX_MICROS = 999_999_999_999_999n;

/**
 * An upstream price is a JSON number (USD per 1M). It becomes a micro-string by
 * formatting to the column's 6 decimals and parsing that DECIMAL STRING — the
 * only arithmetic here is exact string-to-bignum, never float multiplication.
 */
function usdToMicros(value: number | null): string | null {
	if (value === null || !Number.isFinite(value) || value < 0) return null;
	const micro = parseMicros(value.toFixed(6));
	if (micro === null || micro > MAX_MICROS) return null;
	return micro.toString();
}

/** numeric(18,6) money columns are micro-units with 6 digits of scale padding. */
function micros(value: string | null | undefined): bigint {
	const [whole = '0'] = String(value ?? '0').split('.');
	return BigInt(whole);
}

interface AdditionPayload {
	slug: string;
	name: string;
	context: number | null;
	providerModelId: string;
	inputPriceMicro: string;
	outputPriceMicro: string;
}

interface ChangePayload {
	id: string;
	providerModelId: string;
	contextOverride: number | null;
}

/** One ticked addition, re-validated as if it were a hostile form post. */
function parseAddition(raw: FormDataEntryValue | null): AdditionPayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw ?? ''));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const entry = parsed as Record<string, unknown>;
	const slug = parseSlugField(String(entry.slug ?? ''));
	const providerModelId = parseSlugField(String(entry.providerModelId ?? ''));
	const name = String(entry.name ?? slug ?? '').trim().slice(0, 200) || slug;
	const context = parseIntField(String(entry.context ?? ''), { min: 1, max: 100_000_000 });
	const rawContext = String(entry.context ?? '').trim();
	const inputPriceMicro = /^\d{1,15}$/.test(String(entry.inputPriceMicro ?? ''))
		? String(entry.inputPriceMicro)
		: null;
	const outputPriceMicro = /^\d{1,15}$/.test(String(entry.outputPriceMicro ?? ''))
		? String(entry.outputPriceMicro)
		: null;
	if (!slug || !providerModelId || !inputPriceMicro || !outputPriceMicro) return null;
	if (rawContext && context === null) return null;
	return {
		slug,
		name: name || slug,
		context: rawContext ? context : null,
		providerModelId,
		inputPriceMicro,
		outputPriceMicro
	};
}

/** One ticked change: the upstream name and context override to write on a mapping. */
function parseChange(raw: FormDataEntryValue | null): ChangePayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw ?? ''));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const entry = parsed as Record<string, unknown>;
	const id = String(entry.id ?? '').trim();
	const providerModelId = parseSlugField(String(entry.providerModelId ?? ''));
	const rawContext = String(entry.contextOverride ?? '').trim();
	const contextOverride = parseIntField(rawContext, { min: 1, max: 100_000_000 });
	if (!id || !providerModelId) return null;
	if (rawContext && contextOverride === null) return null;
	return { id, providerModelId, contextOverride: rawContext ? contextOverride : null };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.models');
	const providers = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.orderBy(asc(provider.name));
	return { providers };
};

export const actions: Actions = {
	/**
	 * Fetch the upstream catalog and DIFF it against local provider_model rows.
	 * Report-only: nothing is written here — the admin chooses what to apply on
	 * the returned diff, and a removal is a SUGGESTION with no delete path at all.
	 */
	fetch: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		if (!providerId) return fail(400, { error: 'Missing provider' });
		const [p] = await db
			.select({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, credentialsEnc: provider.credentialsEnc })
			.from(provider)
			.where(eq(provider.id, providerId))
			.limit(1);
		if (!p) return fail(404, { error: 'Provider not found' });
		// Endpoint + auth: the provider's first connection carries the real
		// upstream; the legacy provider row is the fallback for S0-era rows.
		const [conn] = await db
			.select({ id: connection.id, baseUrl: connection.baseUrl })
			.from(connection)
			.where(eq(connection.providerId, providerId))
			.orderBy(connection.priority, connection.id)
			.limit(1);
		const baseUrl = conn?.baseUrl ?? p.baseUrl;
		let cred: Credentials = {};
		const [credRow] = conn
			? await db
					.select({ secretEnc: credential.secretEnc })
					.from(credential)
					.where(eq(credential.connectionId, conn.id))
					.orderBy(credential.priority, credential.id)
					.limit(1)
			: [];
		if (credRow) {
			try {
				cred = decryptCredentials(credRow.secretEnc);
			} catch {
				return fail(400, { error: 'Connection credential could not be decrypted' });
			}
		} else if (p.credentialsEnc) {
			try {
				cred = decryptCredentials(p.credentialsEnc);
			} catch {
				return fail(400, { error: 'Provider credential could not be decrypted' });
			}
		}
		// SSRF (contract §8): an admin-supplied URL must clear the public-address
		// guard before it is fetched, on top of the fetcher's own guard.
		const guard = await assertPublicUpstream(baseUrl, allowPrivateUpstreams());
		if (!guard.ok) return fail(400, { error: guard.reason });
		let upstream: UpstreamModel[];
		try {
			const catalog = await fetchUpstreamCatalog(baseUrl, cred);
			if (catalog.status !== 200)
				return fail(502, { error: `Upstream returned HTTP ${catalog.status} for ${catalog.url}` });
			upstream = catalog.models;
		} catch (err) {
			return fail(502, {
				error: `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : 'request failed'}`
			});
		}

		// Local mappings for THIS provider, with the prices the router would use.
		const local = await db
			.select({
				id: providerModel.id,
				providerModelId: providerModel.providerModelId,
				contextOverride: providerModel.contextOverride,
				enabled: providerModel.enabled,
				status: providerModel.status,
				modelId: model.id,
				modelSlug: model.slug,
				modelName: model.name,
				modelContext: model.context,
				modelInputPrice: model.inputPrice,
				modelOutputPrice: model.outputPrice
			})
			.from(providerModel)
			.innerJoin(model, eq(model.id, providerModel.modelId))
			.where(eq(providerModel.providerId, providerId))
			.orderBy(asc(model.slug));
		// Current (open) prices: provider-mapping-specific first, then model-wide.
		const modelIds = [...new Set(local.map((l) => l.modelId))];
		const openRules =
			modelIds.length === 0
				? []
				: await db
						.select()
						.from(pricingRule)
						.where(
							and(
								or(...modelIds.map((id) => eq(pricingRule.modelId, id))),
								isNull(pricingRule.effectiveUntil)
							)
						);
		const ruleFor = new Map(openRules.map((r) => [`${r.modelId}:${r.providerModelId ?? ''}`, r]));

		const byUpstream = new Map(local.map((l) => [matchKey(l.providerModelId), l]));
		const seen = new Set<string>();
		const additions: {
			slug: string;
			name: string;
			context: number | null;
			providerModelId: string;
			inputPriceMicro: string | null;
			outputPriceMicro: string | null;
			json: string;
		}[] = [];
		const changes: {
			id: string;
			slug: string;
			providerModelId: string;
			contextOverride: number | null;
			beforeContext: number | null;
			beforeInput: string;
			beforeOutput: string;
			afterInput: string | null;
			afterOutput: string | null;
			reasons: string[];
			json: string;
		}[] = [];
		for (const m of upstream) {
			const key = matchKey(m.slug);
			seen.add(key);
			const row = byUpstream.get(key);
			const inputMicro = usdToMicros(m.inputUsd);
			const outputMicro = usdToMicros(m.outputUsd);
			if (!row) {
				additions.push({
					slug: key,
					name: m.name,
					context: m.context,
					providerModelId: m.slug,
					inputPriceMicro: inputMicro,
					outputPriceMicro: outputMicro,
					json: JSON.stringify({
						slug: key,
						name: m.name,
						context: m.context,
						providerModelId: m.slug,
						inputPriceMicro: inputMicro ?? '0',
						outputPriceMicro: outputMicro ?? '0'
					})
				});
				continue;
			}
			// Same slug, different fields → a proposed update of the mapping's
			// upstream name and context override. Pricing drift is SHOWN (it needs
			// a versioned price change on the pricing page, never an in-place edit).
			const specific = ruleFor.get(`${row.modelId}:${row.id}`);
			const wide = ruleFor.get(`${row.modelId}:`);
			const currentRule = specific ?? wide ?? null;
			const localInput = currentRule ? micros(currentRule.inputPrice) : micros(row.modelInputPrice);
			const localOutput = currentRule ? micros(currentRule.outputPrice) : micros(row.modelOutputPrice);
			const localContext = row.contextOverride ?? row.modelContext;
			const reasons: string[] = [];
			if (m.context !== null && m.context !== localContext) reasons.push('context');
			if (inputMicro !== null && inputMicro !== localInput.toString()) reasons.push('input price');
			if (outputMicro !== null && outputMicro !== localOutput.toString()) reasons.push('output price');
			if (row.providerModelId !== m.slug) reasons.push('upstream id');
			if (reasons.length === 0) continue;
			changes.push({
				id: row.id,
				slug: row.modelSlug,
				providerModelId: m.slug,
				contextOverride: m.context,
				beforeContext: localContext,
				beforeInput: localInput.toString(),
				beforeOutput: localOutput.toString(),
				afterInput: inputMicro,
				afterOutput: outputMicro,
				reasons,
				json: JSON.stringify({
					id: row.id,
					providerModelId: m.slug,
					contextOverride: m.context
				})
			});
		}
		// Removals: local mappings the upstream no longer reports. SUGGESTIONS
		// ONLY — there is no delete action in this flow, because one missed slug
		// in one fetch must never erase a canonical model or its pricing history.
		const removals = local
			.filter((l) => !seen.has(matchKey(l.providerModelId)))
			.map((l) => ({ id: l.id, slug: l.modelSlug, providerModelId: l.providerModelId }));
		return {
			fetched: {
				providerId,
				providerName: p.name,
				upstreamCount: upstream.length,
				checkedCount: local.length,
				additions,
				changes,
				removals
			}
		};
	},
	/**
	 * Apply the ticked rows from a fetch diff. Additions create the canonical
	 * model (with its mapping and pricing v1) or just the mapping when the slug
	 * already exists; changes update provider_model_id/context_override. NO
	 * DELETE PATH EXISTS HERE — removals are suggestions only. Every write is
	 * audit-logged in its own transaction (PRD §71).
	 */
	apply: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '').trim();
		if (!providerId) return fail(400, { error: 'Missing provider' });
		const [p] = await db
			.select({ id: provider.id, name: provider.name })
			.from(provider)
			.where(eq(provider.id, providerId))
			.limit(1);
		if (!p) return fail(404, { error: 'Provider not found' });
		const additions = form
			.getAll('add')
			.map(parseAddition)
			.filter((a): a is AdditionPayload => a !== null);
		const changes = form
			.getAll('change')
			.map(parseChange)
			.filter((c): c is ChangePayload => c !== null);
		if (additions.length === 0 && changes.length === 0)
			return fail(400, { error: 'Nothing ticked to apply' });

		let added = 0;
		let mapped = 0;
		let changed = 0;
		try {
			for (const row of additions) {
				const existing = await db
					.select({ id: model.id })
					.from(model)
					.where(eq(model.slug, row.slug))
					.limit(1);
				const now = new Date();
				if (existing.length > 0) {
					// The canonical model already exists (e.g. created on the models
					// page) — only the missing provider mapping is added here.
					await db.transaction(async (tx) => {
						const mappingId = newId(ID_PREFIXES.providerModel);
						await tx.insert(providerModel).values({
							id: mappingId,
							modelId: existing[0].id,
							providerId,
							connectionId: null,
							providerModelId: row.providerModelId,
							enabled: true,
							capabilitiesOverride: {},
							contextOverride: row.context,
							status: 'available'
						});
						await writeAudit(tx, {
							actorUserId: locals.user?.id ?? null,
							action: 'provider_model.create',
							resource: 'provider_model',
							resourceId: mappingId,
							after: {
								modelId: existing[0].id,
								providerId,
								providerModelId: row.providerModelId,
								contextOverride: row.context,
								status: 'available',
								source: 'catalog_sync'
							}
						});
					});
					mapped += 1;
					continue;
				}
				// Contract item 13: canonical model + mapping + pricing v1 in one
				// transaction. provider_model_id is the upstream slug as reported.
				await db.transaction(async (tx) => {
					const modelId = newId(ID_PREFIXES.model);
					await tx.insert(model).values({
						id: modelId,
						providerId,
						name: row.name,
						slug: row.slug,
						context: row.context,
						inputPrice: row.inputPriceMicro,
						outputPrice: row.outputPriceMicro,
						currency: 'USD',
						status: 'active',
						modality: {},
						capabilities: {}
					});
					const mappingId = newId(ID_PREFIXES.providerModel);
					await tx.insert(providerModel).values({
						id: mappingId,
						modelId,
						providerId,
						connectionId: null,
						providerModelId: row.providerModelId,
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
						currency: 'USD',
						inputPrice: row.inputPriceMicro,
						cachedInputPrice: null,
						outputPrice: row.outputPriceMicro,
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
						after: {
							name: row.name,
							slug: row.slug,
							context: row.context,
							status: 'active',
							source: 'catalog_sync'
						}
					});
					await writeAudit(tx, {
						actorUserId: locals.user?.id ?? null,
						action: 'provider_model.create',
						resource: 'provider_model',
						resourceId: mappingId,
						after: {
							modelId,
							providerId,
							providerModelId: row.providerModelId,
							source: 'catalog_sync'
						}
					});
					await writeAudit(tx, {
						actorUserId: locals.user?.id ?? null,
						action: 'pricing_rule.create',
						resource: 'pricing_rule',
						resourceId: modelId,
						after: {
							modelId,
							version: 1,
							inputPrice: row.inputPriceMicro,
							outputPrice: row.outputPriceMicro,
							source: 'catalog_sync'
						}
					});
				});
				added += 1;
			}
			for (const row of changes) {
				const [before] = await db
					.select()
					.from(providerModel)
					.where(eq(providerModel.id, row.id))
					.limit(1);
				// The mapping may have vanished since the fetch — skip, never recreate.
				if (!before) continue;
				await db.transaction(async (tx) => {
					await tx
						.update(providerModel)
						.set({
							providerModelId: row.providerModelId,
							contextOverride: row.contextOverride,
							updatedAt: new Date()
						})
						.where(eq(providerModel.id, row.id));
					await writeAudit(tx, {
						actorUserId: locals.user?.id ?? null,
						action: 'provider_model.update',
						resource: 'provider_model',
						resourceId: row.id,
						before: {
							providerModelId: before.providerModelId,
							contextOverride: before.contextOverride
						},
						after: {
							providerModelId: row.providerModelId,
							contextOverride: row.contextOverride,
							source: 'catalog_sync'
						}
					});
				});
				changed += 1;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'write failed';
			return fail(409, { error: `Could not apply sync: ${msg}` });
		}
		return {
			applied: { added, mapped, changed },
			message: `Sync applied: ${added} model(s) created, ${mapped} mapping(s) added, ${changed} mapping(s) updated. Nothing was deleted.`
		};
	}
};
