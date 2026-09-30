import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { observeGate } from '$lib/server/observe/scope';
import { analyticsStats, costStats } from '$lib/server/observe/usage-queries';
import { costMetrics, percentileFromHistogram, type CostMetrics, type UsageTotals } from '$lib/server/observe/metrics';

/**
 * Analytics (PRD §38–39). Engineering metrics + cost analytics over a window.
 * The optional "estimated savings" metric (PRD §39) is deliberately ABSENT from
 * this payload: no baseline price exists anywhere in the schema, so no savings
 * number is computable and the page never shows one (the guide says so too).
 */
const DAY = 86_400_000;

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requireCap(locals, 'member');
	const days = pickDays(url.searchParams.get('days'));
	const to = new Date();
	const from = new Date(to.getTime() - days * DAY);
	const gate = await observeGate(locals, params.projectId, 'analytics.read');
	if (gate.denied) {
		return {
			denied: true,
			projectId: params.projectId,
			range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw', latencySource: 'exact' },
			engineering: null,
			cost: null
		};
	}

	try {
		const [stats, cost] = await Promise.all([
			analyticsStats(db, { workspaceId: gate.workspaceId, projectId: gate.project.id }, from, to),
			costStats(db, { workspaceId: gate.workspaceId, projectId: gate.project.id }, from, to)
		]);
		// Cost analytics from the same totals fold the page reconciles against
		// SUM(request_log.cost) — integer micro-units end to end.
		const totals: UsageTotals = {
			requests: cost.requests,
			tokensIn: 0,
			cachedInputTokens: 0,
			tokensOut: 0,
			reasoningTokens: 0,
			totalTokens: cost.totalTokens,
			costMicro: cost.costMicro,
			successes: 0,
			latencyMsSum: 0,
			ttftMsSum: 0,
			fallbackCount: 0,
			retryCount: 0,
			histogram: {}
		};
		const derived: CostMetrics = costMetrics(totals, cost.providerCostMicro);
		const pct = (n: number) => Math.round(n * 1000) / 10;
		return {
			denied: false,
			queryError: null,
			projectId: gate.project.id,
			projectName: gate.project.name,
			range: {
				days,
				from: from.toISOString(),
				to: to.toISOString(),
				source: stats.source,
				latencySource: stats.latencySource
			},
			engineering: {
				requestCount: stats.requestCount,
				successCount: stats.successCount,
				errorCount: stats.errorCount,
				successRatePct: pct(stats.successRate),
				errorRatePct: pct(stats.errorRate),
				p50: stats.p50,
				p95: stats.p95,
				p99: stats.p99,
				ttftMs: stats.ttftMs,
				tokensPerSecond: stats.tokensPerSecond == null ? null : Math.round(stats.tokensPerSecond * 100) / 100,
				fallbackRatePct: pct(stats.fallbackRate),
				retryRatePct: pct(stats.retryRate),
				providerDistribution: stats.providerDistribution.map((d) => ({
					key: d.key,
					label: d.label || 'Unresolved',
					count: d.count
				})),
				modelDistribution: stats.modelDistribution.map((d) => ({
					key: d.key,
					label: d.label || 'Unresolved',
					count: d.count
				})),
				// Tail honesty: a p99 in the open inf bucket has no finite bound.
				p99Unbounded: stats.p99 == null && stats.requestCount > 0 && stats.latencySource === 'estimated'
					? percentileFromHistogram(stats.histogram, 99) === null
					: false
			},
			cost: {
				totalSpendMicro: derived.totalSpendMicro.toString(),
				costPerRequestMicro: derived.costPerRequestMicro.toString(),
				costPer1mTokensMicro: derived.costPer1mTokensMicro.toString(),
				providerCostMicro: derived.providerCostMicro?.toString() ?? null,
				markupMicro: derived.markupMicro?.toString() ?? null,
				creditsMicro: cost.creditsMicro.toString(),
				totalTokens: cost.totalTokens,
				requests: cost.requests,
				byProvider: cost.byProvider.map(breakRow),
				byModel: cost.byModel.map(breakRow),
				byEnvironment: cost.byEnvironment.map(breakRow),
				byProject: cost.byProject.map(breakRow)
			}
		};
	} catch (err) {
		console.error('[analytics] load failed', err);
		return {
			denied: false,
			queryError: 'Analytics could not be loaded.',
			projectId: params.projectId,
			projectName: '',
			range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw', latencySource: 'exact' },
			engineering: null,
			cost: null
		};
	}
};

const breakRow = (b: { key: string; label: string; costMicro: bigint; providerCostMicro: bigint }) => ({
	key: b.key,
	label: b.label || 'Unresolved',
	costMicro: b.costMicro.toString(),
	providerCostMicro: b.providerCostMicro.toString()
});

/** Windows offered by the page; anything else falls back to 30 days. */
function pickDays(raw: string | null): number {
	const n = Number(raw);
	return [1, 7, 30, 90].includes(n) ? n : 30;
}
