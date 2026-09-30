import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { observeWorkspaceGate } from '$lib/server/observe/scope';
import { creditsCharged, usageBreakdowns, usageTotals } from '$lib/server/observe/usage-queries';

/**
 * Usage (PRD §37): workspace-wide usage over a window — requests, the token
 * splits, cost and credits — broken down by project / environment / API key /
 * model / provider / day. Long ranges read the `usage_daily` rollup, short
 * ranges the raw `request_log` (PRD §96); `source` says which answered, so a
 * rollup gap is labelled instead of shown as confident zeros.
 */
const DAY = 86_400_000;

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const gate = await observeWorkspaceGate(locals, 'usage.read');
	const days = pickDays(url.searchParams.get('days'));
	if (gate.denied) return { denied: true, queryError: null, range: { days }, totals: null, breakdowns: null };

	const to = new Date();
	const from = new Date(to.getTime() - days * DAY);
	try {
		const [{ totals, source }, credits, breakdowns] = await (async () => {
			const totalsResult = await usageTotals(db, { workspaceId: gate.workspaceId }, from, to);
			// Breakdowns read the SAME source the totals came from (PRD §96): raw
			// rows for short windows, `usage_daily` for rolled-up long windows. A
			// rollup gap was already resolved into `source: 'raw'` above, so the
			// page can never show partial aggregates as complete.
			const [credits, breakdowns] = await Promise.all([
				creditsCharged(db, { workspaceId: gate.workspaceId }, from, to),
				usageBreakdowns(
					db,
					{ workspaceId: gate.workspaceId },
					from,
					to,
					totalsResult.source
				)
			]);
			return [totalsResult, credits, breakdowns] as const;
		})();
		return {
			denied: false,
			queryError: null,
			range: {
				days,
				from: from.toISOString(),
				to: to.toISOString(),
				source
			},
			totals: {
				requests: totals.requests,
				tokensIn: totals.tokensIn,
				cachedInputTokens: totals.cachedInputTokens,
				tokensOut: totals.tokensOut,
				reasoningTokens: totals.reasoningTokens,
				totalTokens: totals.totalTokens,
				costMicro: totals.costMicro.toString(),
				creditsMicro: credits.toString()
			},
			// Breakdowns follow the same source as the totals: aggregates for
			// rolled-up long ranges, raw rows otherwise.
			breakdowns: breakdowns && {
				byProject: breakdowns.byProject.map(breakRow),
				byEnvironment: breakdowns.byEnvironment.map(breakRow),
				byApiKey: breakdowns.byApiKey.map(breakRow),
				byModel: breakdowns.byModel.map(breakRow),
				byProvider: breakdowns.byProvider.map(breakRow),
				byDay: breakdowns.byDay.map(breakRow)
			}
		};
	} catch (err) {
		console.error('[usage] load failed', err);
		return {
			denied: false,
			queryError: 'Usage could not be loaded.',
			range: { days, from: from.toISOString(), to: to.toISOString(), source: 'raw' },
			totals: null,
			breakdowns: null
		};
	}
};

const breakRow = (b: { key: string; label: string; requests: number; totalTokens: number; costMicro: bigint }) => ({
	key: b.key,
	label: b.label || 'Unresolved',
	requests: b.requests,
	totalTokens: b.totalTokens,
	costMicro: b.costMicro.toString()
});

function pickDays(raw: string | null): number {
	const n = Number(raw);
	return [1, 7, 30, 90].includes(n) ? n : 30;
}
