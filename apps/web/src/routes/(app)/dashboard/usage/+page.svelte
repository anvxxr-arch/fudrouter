<script lang="ts">
	import { formatCost, formatTokens } from '$lib/format';
	import { resolve } from '$app/paths';
	import {
		ButtonLink,
		Guide,
		PageHeader,
		Section,
		StatCard,
		TableWrap,
		UsageChart,
		UxState
	} from '$lib/ui';
	let { data } = $props();
	const state = $derived(
		data.denied ? 'denied' : data.queryError ? 'error' : !data.totals ? 'empty' : 'success'
	);
	const currency = 'USD';
	const days = [1, 7, 30, 90];
	const rangeHref = (d: number) => resolve('/dashboard/usage') + `?days=${d}`;
	const chartDays = $derived(
		(data.breakdowns?.byDay ?? []).map((d) => ({
			day: d.key,
			requests: d.requests,
			tokens: d.totalTokens,
			cost: d.costMicro
		}))
	);
	// Explicit rows per section: a `data.breakdowns[key]` index on a `string`
	// key widens to `any` and loses the row shape. Every section reads the
	// same BreakRow columns (key/label/requests/totalTokens/costMicro).
	type BreakRow = {
		key: string;
		label: string;
		requests: number;
		totalTokens: number;
		costMicro: string;
	};
	const sections: { id: string; title: string; label: string; rows: BreakRow[] }[] = $derived(
		data.breakdowns
			? [
					{ id: 'byDay', title: 'By day', label: 'Day', rows: data.breakdowns.byDay },
					{ id: 'byProject', title: 'By project', label: 'Project', rows: data.breakdowns.byProject },
					{ id: 'byEnvironment', title: 'By environment', label: 'Environment', rows: data.breakdowns.byEnvironment },
					{ id: 'byApiKey', title: 'By API key', label: 'API key', rows: data.breakdowns.byApiKey },
					{ id: 'byModel', title: 'By model', label: 'Model', rows: data.breakdowns.byModel },
					{ id: 'byProvider', title: 'By provider', label: 'Provider', rows: data.breakdowns.byProvider }
				]
			: []
	);
</script>

<PageHeader title="Usage" lede="Everything this workspace routed, with cost and credits." />
<Guide id="usage" />

<nav class="ranges" aria-label="Time window">
	{#each days as d (d)}
		<ButtonLink href={rangeHref(d)} variant={data.range.days === d ? 'primary' : 'ghost'}
			>{d} day{d > 1 ? 's' : ''}</ButtonLink
		>
	{/each}
</nav>

<UxState
	{state}
	emptyTitle="No usage in this window"
	emptyHint="Widen the window — or send a request and it lands here within moments."
	errorWhat={data.queryError ?? undefined}
	errorWhy="Reading usage failed on the server."
>
	{#if data.totals}
		<p class="muted">
			{data.range.days} day{data.range.days > 1 ? 's' : ''} · source:
			{data.range.source === 'aggregates'
				? 'daily rollup'
				: 'raw request log (rollup not yet rolled up for this window)'}
		</p>
		<section class="stats">
			<StatCard label="Requests" value={formatTokens(data.totals.requests)} />
			<StatCard label="Input tokens" value={formatTokens(data.totals.tokensIn)} />
			<StatCard label="Cached input" value={formatTokens(data.totals.cachedInputTokens)} />
			<StatCard label="Output tokens" value={formatTokens(data.totals.tokensOut)} />
			<StatCard label="Reasoning tokens" value={formatTokens(data.totals.reasoningTokens)} />
			<StatCard label="Total tokens" value={formatTokens(data.totals.totalTokens)} />
			<StatCard label="Cost" value={formatCost(BigInt(data.totals.costMicro), currency)} />
			<StatCard label="Credits charged" value={formatCost(BigInt(data.totals.creditsMicro), currency)} />
		</section>
	{/if}

	{#if data.breakdowns}
		<Section title="Requests per day">
			<UsageChart days={chartDays} label="Requests per day" />
		</Section>

		{#each sections as s (s.id)}
		<Section title={s.title}>
			<TableWrap label={s.title}>
				<table class="fr">
					<thead><tr><th>{s.label}</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
					<tbody>
						{#each s.rows as b (b.key || b.label)}
							<tr>
								<td class={s.id === 'byDay' ? 'num' : ''}>{s.id === 'byDay' ? b.key : b.label}</td>
								<td class="num">{formatTokens(b.requests)}</td>
								<td class="num">{formatTokens(b.totalTokens)}</td>
								<td class="num">{formatCost(BigInt(b.costMicro), currency)}</td>
							</tr>
						{:else}
							<tr><td colspan="4">No usage in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>
	{/each}
	{/if}
</UxState>

<style>
	.ranges {
		display: flex;
		gap: var(--space-sm);
		margin: var(--space-md) 0;
	}
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
	}
</style>
