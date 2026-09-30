/**
 * Public catalog data — the one query layer behind /models, /models/[slug],
 * /models/compare, /pricing and /providers.
 *
 * Reads `model` + `provider_model` + `connection` + `provider` + `pricing_rule`
 * (+ `request_log` for observed performance) and applies the SAME publish gate
 * the data plane serves (`reachability` from $lib/publish), so the public pages
 * cannot advertise a slug the router would refuse.
 *
 * Credential material NEVER crosses this boundary: the row shapes below carry
 * identity, status, pricing and aggregate performance only.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { reachability } from '$lib/publish';
import { allowDevProviders } from '$lib/server/publish-env';
import { db } from '$lib/server/db';
import {
	connection,
	model,
	pricingRule,
	provider,
	providerModel,
	requestLog
} from '$lib/server/db/schema';

/** Micro-units of currency per 1M tokens as decimal strings (money never a float). */
export interface PriceMicro {
	inputPriceMicro: string;
	cachedInputPriceMicro: string | null;
	outputPriceMicro: string | null;
	reasoningPriceMicro: string | null;
	currency: string;
}
export interface ProviderAvailability {
	providerName: string;
	providerSlug: string | null;
	connectionName: string | null;
	region: string | null;
	providerModelId: string;
	status: string;
	enabled: boolean;
	/** Per-provider price when it differs from the model-wide rule. */
	price: PriceMicro | null;
	p50Ms: number | null;
	p95Ms: number | null;
	availability: number | null;
}
export interface CatalogModel {
	id: string;
	slug: string;
	name: string;
	family: string | null;
	developer: string | null;
	description: string | null;
	context: number | null;
	maxOutput: number | null;
	modality: Record<string, unknown>;
	capabilities: Record<string, boolean>;
	status: string;
	currency: string;
	/** Model-wide normalized price (PRD §15: per 1M input / cached input / output). */
	price: PriceMicro;
	providers: ProviderAvailability[];
	/** Rollup across served providers, for catalog tables and compare. */
	p50Ms: number | null;
	p95Ms: number | null;
	availability: number | null;
}

/** The effective (current) model-wide pricing rule, or the legacy columns when none exists. */
const modelWidePrice = sql<Record<string, string | null>>`
	coalesce(
		(select jsonb_build_object(
			'input', pr.input_price::text,
			'cached', pr.cached_input_price::text,
			'output', pr.output_price::text,
			'reasoning', pr.reasoning_price::text,
			'currency', pr.currency
		)
		from pricing_rule pr
		where pr.model_id = ${model.id}
		  and pr.provider_model_id is null
		  and pr.effective_from <= now()
		  and (pr.effective_until is null or pr.effective_until > now())
		order by pr.version desc limit 1),
		jsonb_build_object(
			'input', ${model.inputPrice}::text,
			'cached', null,
			'output', ${model.outputPrice}::text,
			'reasoning', null,
			'currency', ${model.currency}
		)
	)`;

/** Per-provider_model price when a specific rule exists (PRD §6: specific wins). */
const providerSpecificPrice = sql<Record<string, string | null> | null>`
	(select jsonb_build_object(
		'input', pr.input_price::text,
		'cached', pr.cached_input_price::text,
		'output', pr.output_price::text,
		'reasoning', pr.reasoning_price::text,
		'currency', pr.currency
	)
	from pricing_rule pr
	where pr.provider_model_id = ${providerModel.id}
	  and pr.effective_from <= now()
	  and (pr.effective_until is null or pr.effective_until > now())
	order by pr.version desc limit 1)`;

interface RawRow {
	modelId: string;
	slug: string;
	name: string;
	family: string | null;
	developer: string | null;
	description: string | null;
	context: number | null;
	maxOutput: number | null;
	modality: Record<string, unknown>;
	capabilities: Record<string, boolean>;
	modelStatus: string;
	widePrice: Record<string, string | null>;
	pmId: string;
	pmProviderModelId: string;
	pmStatus: string;
	pmEnabled: boolean;
	contextOverride: number | null;
	capabilitiesOverride: Record<string, boolean>;
	providerName: string;
	providerSlug: string | null;
	providerStatus: string;
	connectionName: string | null;
	region: string | null;
	specPrice: Record<string, string | null> | null;
}

function toPrice(raw: Record<string, string | null>): PriceMicro {
	return {
		inputPriceMicro: raw.input ?? '0',
		cachedInputPriceMicro: raw.cached ?? null,
		outputPriceMicro: raw.output ?? null,
		reasoningPriceMicro: raw.reasoning ?? null,
		currency: raw.currency ?? 'USD'
	};
}

function priceDiffers(wide: PriceMicro, spec: PriceMicro): boolean {
	return (
		wide.inputPriceMicro !== spec.inputPriceMicro ||
		(wide.cachedInputPriceMicro ?? null) !== (spec.cachedInputPriceMicro ?? null) ||
		(wide.outputPriceMicro ?? null) !== (spec.outputPriceMicro ?? null) ||
		(wide.reasoningPriceMicro ?? null) !== (spec.reasoningPriceMicro ?? null)
	);
}

/**
 * Observed latency percentiles and availability per (model, provider_model).
 *
 * Availability = successes / requests over the retained window. A model with no
 * traffic gets `null` — absence of data is not a claim (PRD §122 semantics).
 */
async function observedStats(
	pmIds: string[]
): Promise<Map<string, { p50: number | null; p95: number | null; availability: number | null }>> {
	const out = new Map<
		string,
		{ p50: number | null; p95: number | null; availability: number | null }
	>();
	if (pmIds.length === 0) return out;
	// percentile_disc over ordered latency_ms; empty arrays yield NULL.
	const rows = await db
		.select({
			pmId: requestLog.providerModelId,
			p50: sql<number | null>`percentile_disc(0.5) within group (order by ${requestLog.latencyMs})::int`,
			p95: sql<number | null>`percentile_disc(0.95) within group (order by ${requestLog.latencyMs})::int`,
			total: sql<number>`count(*)::int`,
			ok: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`
		})
		.from(requestLog)
		.where(inArray(requestLog.providerModelId, pmIds))
		.groupBy(requestLog.providerModelId);
	for (const r of rows) {
		if (!r.pmId) continue;
		out.set(r.pmId, {
			p50: r.p50,
			p95: r.p95,
			availability: r.total > 0 ? r.ok / r.total : null
		});
	}
	return out;
}

/**
 * Every served model with its provider availability, per the publish gate.
 *
 * `slugs` narrows to specific slugs (detail/compare/pricing-by-model); omitted
 * means the whole catalog. Ordering is by slug so callers never re-sort.
 */
export async function servedModels(slugs?: string[]): Promise<CatalogModel[]> {
	const allowDev = allowDevProviders();
	const where = slugs ? inArray(model.slug, slugs) : undefined;
	const rows = (await db
		.select({
			modelId: model.id,
			slug: model.slug,
			name: model.name,
			family: model.family,
			developer: model.developer,
			description: model.description,
			context: model.context,
			maxOutput: model.maxOutput,
			modality: model.modality,
			capabilities: model.capabilities,
			modelStatus: model.status,
			widePrice: modelWidePrice,
			pmId: providerModel.id,
			pmProviderModelId: providerModel.providerModelId,
			pmStatus: providerModel.status,
			pmEnabled: providerModel.enabled,
			contextOverride: providerModel.contextOverride,
			capabilitiesOverride: providerModel.capabilitiesOverride,
			providerName: provider.name,
			providerSlug: provider.slug,
			providerStatus: provider.status,
			connectionName: connection.name,
			region: connection.region,
			specPrice: providerSpecificPrice
		})
		.from(model)
		.innerJoin(providerModel, and(eq(providerModel.modelId, model.id), eq(providerModel.enabled, true)))
		.innerJoin(provider, eq(provider.id, providerModel.providerId))
		.leftJoin(connection, eq(connection.id, providerModel.connectionId))
		.where(where)
		.orderBy(asc(model.slug), asc(provider.name))) as unknown as RawRow[];

	// Publish gate: a model is served only through provider_models whose provider
	// the router would serve. A model with zero served mappings is dropped.
	const served = rows.filter(
		(r) => reachability(r.modelStatus, r.providerStatus, allowDev).served
	);
	const stats = await observedStats([...new Set(served.map((r) => r.pmId))]);

	const byModel = new Map<string, CatalogModel>();
	for (const r of served) {
		let entry = byModel.get(r.modelId);
		if (!entry) {
			const wide = toPrice(r.widePrice);
			entry = {
				id: r.modelId,
				slug: r.slug,
				name: r.name,
				family: r.family,
				developer: r.developer,
				description: r.description,
				context: r.context,
				maxOutput: r.maxOutput,
				modality: r.modality ?? {},
				capabilities: r.capabilities ?? {},
				status: r.modelStatus,
				currency: wide.currency,
				price: wide,
				providers: [],
				p50Ms: null,
				p95Ms: null,
				availability: null
			};
			byModel.set(r.modelId, entry);
		}
		const wide = entry.price;
		const spec = r.specPrice ? toPrice(r.specPrice) : null;
		const s = stats.get(r.pmId);
		entry.providers.push({
			providerName: r.providerName,
			providerSlug: r.providerSlug,
			connectionName: r.connectionName,
			region: r.region,
			providerModelId: r.pmProviderModelId,
			status: r.pmStatus,
			enabled: r.pmEnabled,
			price: spec && priceDiffers(wide, spec) ? spec : null,
			p50Ms: s?.p50 ?? null,
			p95Ms: s?.p95 ?? null,
			availability: s?.availability ?? null
		});
	}
	// Rollup: best (lowest) observed latency and mean availability across the
	// served providers. No traffic anywhere → null, not a guess.
	for (const entry of byModel.values()) {
		const withTraffic = entry.providers.filter((p) => p.p50Ms !== null);
		const p50s = withTraffic.map((p) => p.p50Ms!).sort((a, b) => a - b);
		const p95s = withTraffic.map((p) => p.p95Ms!).sort((a, b) => a - b);
		entry.p50Ms = p50s.length ? p50s[Math.floor((p50s.length - 1) / 2)] : null;
		entry.p95Ms = p95s.length ? p95s[Math.floor((p95s.length - 1) / 2)] : null;
		const avails = entry.providers
			.map((p) => p.availability)
			.filter((a): a is number => a !== null);
		entry.availability = avails.length
			? avails.reduce((a, b) => a + b, 0) / avails.length
			: null;
	}
	return [...byModel.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The identifiers a client can use for a model (PRD §15 "Model Identifiers"):
 * the canonical FUDRouter slug, the provider-scoped form, and each provider's
 * own upstream name.
 */
export function identifiersOf(m: CatalogModel): {
	canonical: string;
	fudrouter: string;
	providerForms: { providerName: string; id: string }[];
} {
	return {
		canonical: m.slug,
		fudrouter: m.slug,
		providerForms: m.providers.map((p) => ({ providerName: p.providerName, id: p.providerModelId }))
	};
}
