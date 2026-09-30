/**
 * `SimStore` over drizzle (PRD §64). The simulator reads candidates ONLY
 * through this store, so this module is the entire data surface of a routing
 * simulation: `provider_model` rows for one model, joined to `provider` +
 * `connection`, priced by the latest effective `pricing_rule` (falling back to
 * the legacy `model` price columns), with availability and p95 latency
 * aggregated from `request_log`.
 *
 * The row → candidate shaping is exported as pure functions so it can be
 * tested without a database; `PgSimStore` itself is two selects and a join in
 * memory. No network, no upstream, no side effects — the engine must stay
 * replayable.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { connection, model, provider, providerModel, requestLog } from '$lib/server/db/schema';
import type { SimCandidate, SimStore } from './admin-simulate';

/** The two price fields of one effective `pricing_rule`, as numeric(18,6) text. */
export interface SimRulePrice {
	input: string | null;
	output: string | null;
}

/** One candidate as the query returns it: prices are numeric(18,6) TEXT. */
export interface SimRow {
	providerId: string;
	providerName: string;
	providerPriority: number;
	connectionId: string | null;
	connectionName: string | null;
	/** `provider_model.id` (the mapping row). */
	providerModelId: string;
	pmEnabled: boolean;
	/** `connection.health_status`, or null when the mapping is connectionless. */
	healthStatus: string | null;
	/** Latest effective provider-specific pricing rule (PRD §60: specific wins). */
	specificPrice: SimRulePrice | null;
	/** Latest effective model-wide pricing rule. */
	widePrice: SimRulePrice | null;
	/** Legacy `model.input_price`/`output_price` fallback (always present). */
	legacyInputPrice: string;
	legacyOutputPrice: string;
	successes: number | null;
	total: number | null;
	p95LatencyMs: number | null;
}

/**
 * numeric(18,6) text → bigint micro-units (floor). Price columns are
 * micro-units of currency per 1M tokens; the scale-6 fraction is sub-micro
 * precision the simulator never needs, so the integer part is the price.
 */
export function numericMicros(text: string | null | undefined, fallback = 0n): bigint {
	if (text == null) return fallback;
	const m = /^-?\d+/.exec(String(text).trim());
	return m ? BigInt(m[0]) : fallback;
}

/**
 * The price a candidate scores with: provider-specific rule, else model-wide
 * rule, else the legacy model columns (which are NOT NULL and always safe).
 */
export function pickPrice(row: SimRow): { inputPriceMicro: bigint; outputPriceMicro: bigint } {
	const rule = row.specificPrice ?? row.widePrice;
	return {
		inputPriceMicro: numericMicros(rule?.input ?? null, numericMicros(row.legacyInputPrice)),
		outputPriceMicro: numericMicros(rule?.output ?? null, numericMicros(row.legacyOutputPrice))
	};
}

/** Shape one joined row into the simulator's candidate record. */
export function rowToCandidate(row: SimRow): SimCandidate {
	const price = pickPrice(row);
	const total = row.total ?? 0;
	return {
		providerId: row.providerId,
		providerName: row.providerName,
		providerPriority: row.providerPriority,
		connectionId: row.connectionId,
		connectionName: row.connectionName,
		providerModelId: row.providerModelId,
		inputPriceMicro: price.inputPriceMicro,
		outputPriceMicro: price.outputPriceMicro,
		// No recorded traffic is UNKNOWN, not unhealthy — a brand-new mapping
		// must not score as a dead one, so the neutral availability is 1.
		availability: total > 0 ? Math.min(1, Math.max(0, (row.successes ?? 0) / total)) : 1,
		p95LatencyMs: row.p95LatencyMs ?? 0,
		healthStatus: row.healthStatus ?? 'unknown',
		enabled: row.pmEnabled
	};
}

/** Latest effective rule (`effective_from <= now < effective_until`) at `version`. */
function effectiveRule(providerModelId: SQLWrapper | string | null, modelId: string): SQL<SimRulePrice | null> {
	// Whole subquery in one template: `pricing_rule pr` is in the subquery's own
	// FROM, so every column reference must use the `pr.` alias — a drizzle
	// column fragment would render `"pricing_rule"."col"` and not resolve.
	if (providerModelId) {
		return sql<SimRulePrice | null>`
			(select jsonb_build_object(
				'input', pr.input_price::text,
				'output', pr.output_price::text
			)
			from pricing_rule pr
			where pr.provider_model_id = ${providerModelId}
			  and pr.effective_from <= now()
			  and (pr.effective_until is null or pr.effective_until > now())
			order by pr.version desc
			limit 1)`;
	}
	return sql<SimRulePrice | null>`
		(select jsonb_build_object(
			'input', pr.input_price::text,
			'output', pr.output_price::text
		)
		from pricing_rule pr
		where pr.model_id = ${modelId}
		  and pr.provider_model_id is null
		  and pr.effective_from <= now()
		  and (pr.effective_until is null or pr.effective_until > now())
		order by pr.version desc
		limit 1)`;
}

/**
 * The drizzle `SimStore`. Two reads per simulation: the candidate join, then
 * `request_log` aggregates for exactly the mappings found.
 */
export class PgSimStore implements SimStore {
	async candidates(modelId: string): Promise<SimCandidate[]> {
		const rows = await db
			.select({
				providerId: provider.id,
				providerName: provider.name,
				providerPriority: provider.priority,
				connectionId: connection.id,
				connectionName: connection.name,
				providerModelId: providerModel.id,
				pmEnabled: providerModel.enabled,
				healthStatus: connection.healthStatus,
				specificPrice: effectiveRule(providerModel.id, modelId),
				widePrice: effectiveRule(null, modelId),
				legacyInputPrice: model.inputPrice,
				legacyOutputPrice: model.outputPrice
			})
			.from(providerModel)
			.innerJoin(model, eq(model.id, providerModel.modelId))
			.innerJoin(provider, eq(provider.id, providerModel.providerId))
			.leftJoin(connection, eq(connection.id, providerModel.connectionId))
			.where(eq(providerModel.modelId, modelId))
			.orderBy(provider.priority, provider.name);
		if (rows.length === 0) return [];
		const ids = rows.map((r) => r.providerModelId);
		const stats = await db
			.select({
				pmId: requestLog.providerModelId,
				successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
				total: sql<number>`count(*)::int`,
				p95LatencyMs: sql<number>`(percentile_cont(0.95) within group (order by ${requestLog.latencyMs}))::int`
			})
			.from(requestLog)
			.where(inArray(requestLog.providerModelId, ids))
			.groupBy(requestLog.providerModelId);
		const byPm = new Map(stats.map((s) => [s.pmId, s]));
		return rows.map((r) => {
			const s = byPm.get(r.providerModelId);
			return rowToCandidate({
				...r,
				successes: s?.successes ?? null,
				total: s?.total ?? null,
				p95LatencyMs: s?.p95LatencyMs ?? null
			});
		});
	}
}
