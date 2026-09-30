/**
 * Effective rate-limit chain (spec §7): the enforced value of a metric is the
 * MINIMUM across platform default → workspace → project → environment →
 * api_key. A specific level may tighten, never exceed the platform hard limit.
 *
 * Pure rule module — rows are read elsewhere and fed in as `LimitValues`.
 * NULL means "no limit at this level" = inherit (spec §3), which must NOT be
 * treated as zero: a missing value constrains nothing.
 */

export const LIMIT_METRICS = [
	'rpm',
	'tpm',
	'rpd',
	'tpd',
	'concurrency',
	'dailySpendMicro',
	'monthlySpendMicro'
] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

export const LIMIT_LEVELS = ['platform', 'workspace', 'project', 'environment', 'api_key'] as const;
export type LimitLevel = (typeof LIMIT_LEVELS)[number];

export type LimitValues = {
	rpm: number | null;
	tpm: number | null;
	rpd: number | null;
	tpd: number | null;
	concurrency: number | null;
	dailySpendMicro: bigint | null;
	monthlySpendMicro: bigint | null;
};

export const NO_LIMITS: LimitValues = {
	rpm: null,
	tpm: null,
	rpd: null,
	tpd: null,
	concurrency: null,
	dailySpendMicro: null,
	monthlySpendMicro: null
};

export type LimitChainEntry = { level: LimitLevel; values: LimitValues };

export type EffectiveLimit = {
	metric: LimitMetric;
	/** Enforced value (min of the chain); null = no limit anywhere. */
	effective: number | bigint | null;
	/** The most specific level holding the effective value — the one to edit. */
	boundAt: LimitLevel | null;
	byLevel: Partial<Record<LimitLevel, number | bigint | null>>;
};

/**
 * Resolve every metric down the chain. On a tie the most specific level is
 * reported as binding: it is the level an operator can actually edit to loosen
 * the limit, so pointing there is actionable where "platform" would not be.
 */
export function effectiveLimits(chain: LimitChainEntry[]): EffectiveLimit[] {
	return LIMIT_METRICS.map((metric) => {
		let effective: number | bigint | null = null;
		let boundAt: LimitLevel | null = null;
		const byLevel: Partial<Record<LimitLevel, number | bigint | null>> = {};
		for (const { level, values } of chain) {
			const value = values[metric];
			byLevel[level] = value ?? null;
			if (value == null) continue;
			// bigint/number never mix inside one metric: spend metrics are bigint
			// end to end, count metrics are number end to end. `<=` (not `<`):
			// on a tie the MOST SPECIFIC level wins (LIMIT_LEVELS is ordered from
			// platform outward), because that is the level an operator edits to
			// loosen the limit — pointing at "platform" would not be actionable.
			const tighter = effective == null || (value as bigint) <= (effective as bigint);
			if (tighter) {
				effective = value;
				boundAt = level;
			}
		}
		return { metric, effective, boundAt, byLevel };
	});
}

export function isSpendMetric(metric: LimitMetric): boolean {
	return metric === 'dailySpendMicro' || metric === 'monthlySpendMicro';
}

/** Human label for a metric — the form and the chain table share these. */
export const LIMIT_LABELS: Record<LimitMetric, string> = {
	rpm: 'Requests per minute',
	tpm: 'Tokens per minute',
	rpd: 'Requests per day',
	tpd: 'Tokens per day',
	concurrency: 'Concurrent requests',
	dailySpendMicro: 'Daily spend',
	monthlySpendMicro: 'Monthly spend'
};

/** Human label for a chain level. */
export const LIMIT_LEVEL_LABELS: Record<LimitLevel, string> = {
	platform: 'Platform default',
	workspace: 'Workspace',
	project: 'Project',
	environment: 'Environment',
	api_key: 'API key'
};
