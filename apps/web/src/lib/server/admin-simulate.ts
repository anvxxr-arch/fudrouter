/**
 * Routing simulation (PRD §64) — score candidate provider models for a
 * hypothetical request and report WHY each candidate ranks where it does.
 *
 * This is a planning tool, not a request path: it reads configuration and
 * health data through the injected `SimStore` and does **no inference**, no
 * upstream fetch, no side effect of any kind. The store is injected precisely
 * so that property is enforceable in a test: a stubbed store that records every
 * call proves the simulator reaches nothing else.
 *
 * Money never touches a float: estimated cost is bigint micro-units
 * (price columns are micro-units per 1M tokens, spec §6).
 */
export const SIM_STRATEGIES = [
	'balanced',
	'lowest_cost',
	'lowest_latency',
	'highest_reliability',
	'provider_priority',
	'weighted',
	'round_robin',
	'random',
	'smart'
] as const;
export type SimStrategy = (typeof SIM_STRATEGIES)[number];

export interface SimCandidate {
	providerId: string;
	providerName: string;
	/** Lower wins on ties; from `provider.priority`. */
	providerPriority: number;
	connectionId: string | null;
	connectionName: string | null;
	providerModelId: string;
	/** Micro-units per 1M tokens (numeric(18,6) columns). */
	inputPriceMicro: bigint;
	outputPriceMicro: bigint;
	/** 0..1 observed availability. */
	availability: number;
	p95LatencyMs: number;
	/** `connection.health_status` vocabulary. */
	healthStatus: string;
	enabled: boolean;
}

/**
 * The only data source the simulator may touch. Implemented over drizzle
 * selects in `admin-sim-store.ts`; stubbed in tests.
 */
export interface SimStore {
	candidates(modelId: string): Promise<SimCandidate[]>;
}

export interface SimInput {
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	strategy: SimStrategy;
	weights?: { price?: number; latency?: number; reliability?: number; capacity?: number };
}

export interface SimResultRow {
	providerId: string;
	providerName: string;
	connectionId: string | null;
	connectionName: string | null;
	providerModelId: string;
	estimatedCostMicro: bigint;
	healthStatus: string;
	availability: number;
	p95LatencyMs: number;
	score: number;
	reason: string;
}

export interface SimResult {
	strategy: SimStrategy;
	candidatesConsidered: number;
	rows: SimResultRow[];
}

const DEFAULT_WEIGHTS = { price: 0.4, latency: 0.3, reliability: 0.2, capacity: 0.1 };

/** Cost of a hypothetical call in micro-units (bigint, floor at 0). */
export function estimateCostMicro(c: SimCandidate, inputTokens: number, outputTokens: number): bigint {
	const tin = BigInt(Math.max(0, Math.trunc(inputTokens)));
	const tout = BigInt(Math.max(0, Math.trunc(outputTokens)));
	const cost = (tin * c.inputPriceMicro + tout * c.outputPriceMicro) / 1_000_000n;
	return cost < 0n ? 0n : cost;
}

/** min-max normalisation to 0..1 across the field; a flat field scores 1. */
function normalize(values: number[], invert: boolean): number[] {
	const min = Math.min(...values);
	const max = Math.max(...values);
	if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return values.map(() => 1);
	return values.map((v) => {
		const n = (v - min) / (max - min);
		return invert ? 1 - n : n;
	});
}

/**
 * Rank candidates. One store read, pure scoring, deterministic order
 * (score, then cost, then provider id) — `round_robin`/`random` are modelled
 * deterministically because a simulator must reproduce its own answer.
 */
export async function simulateRouting(store: SimStore, input: SimInput): Promise<SimResult> {
	const candidates = await store.candidates(input.modelId);
	const costs = candidates.map((c) => estimateCostMicro(c, input.inputTokens, input.outputTokens));
	const costScores = normalize(
		costs.map((c) => Number(c)),
		true
	);
	const latencyScores = normalize(candidates.map((c) => c.p95LatencyMs), true);
	const availScores = normalize(candidates.map((c) => c.availability), false);
	const priorityScores = normalize(candidates.map((c) => c.providerPriority), true);

	const w = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
	const wSum = (w.price ?? 0) + (w.latency ?? 0) + (w.reliability ?? 0) + (w.capacity ?? 0) || 1;

	const rows: SimResultRow[] = candidates.map((c, i) => {
		let score: number;
		let reason: string;
		if (!c.enabled) {
			score = 0;
			reason = 'mapping disabled — not routable';
		} else {
			switch (input.strategy) {
				case 'lowest_cost':
					score = costScores[i];
					reason = 'ranked by estimated cost for the token estimate';
					break;
				case 'lowest_latency':
					score = latencyScores[i];
					reason = `ranked by observed p95 latency (${c.p95LatencyMs} ms)`;
					break;
				case 'highest_reliability':
					score = availScores[i];
					reason = `ranked by observed availability (${(c.availability * 100).toFixed(1)}%)`;
					break;
				case 'provider_priority':
					score = priorityScores[i];
					reason = `ranked by provider priority (${c.providerPriority})`;
					break;
				case 'round_robin':
					score = 1 - i / Math.max(1, candidates.length);
					reason = `rotation slot ${i + 1} of ${candidates.length} (simulated order is deterministic)`;
					break;
				case 'random':
					score = 1 - i / Math.max(1, candidates.length);
					reason = `shuffle slot ${i + 1} of ${candidates.length} (simulated order is deterministic)`;
					break;
				case 'smart':
				case 'balanced':
				case 'weighted':
				default: {
					const mixed =
						((w.price ?? 0) * costScores[i] +
							((w.latency ?? 0) * latencyScores[i] +
								(w.reliability ?? 0) * availScores[i] +
								(w.capacity ?? 0) * priorityScores[i])) /
						wSum;
					score = mixed;
					reason = `weighted mix (price ${(w.price ?? 0)}, latency ${(w.latency ?? 0)}, reliability ${(w.reliability ?? 0)}, capacity ${(w.capacity ?? 0)})`;
					break;
				}
			}
		}
		return {
			providerId: c.providerId,
			providerName: c.providerName,
			connectionId: c.connectionId,
			connectionName: c.connectionName,
			providerModelId: c.providerModelId,
			estimatedCostMicro: costs[i],
			healthStatus: c.healthStatus,
			availability: c.availability,
			p95LatencyMs: c.p95LatencyMs,
			score: Math.round(score * 1000) / 1000,
			reason
		};
	});

	rows.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.estimatedCostMicro !== b.estimatedCostMicro)
			return a.estimatedCostMicro < b.estimatedCostMicro ? -1 : 1;
		return a.providerId.localeCompare(b.providerId);
	});

	return { strategy: input.strategy, candidatesConsidered: candidates.length, rows };
}
