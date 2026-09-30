<script lang="ts">
	import { formatCost, formatTokens } from '$lib/format';
	import {
		Alert,
		ButtonLink,
		Guide,
		PageHeader,
		Section,
		StatCard,
		TableWrap,
		UxState
	} from '$lib/ui';
	let { data } = $props();
	const state = $derived(data.denied ? 'denied' : data.queryError ? 'error' : !data.engineering ? 'empty' : 'success');
	const e = $derived(data.engineering);
	const c = $derived(data.cost);
	const currency = 'USD';
	// Percentile labels: exact on raw rows, bucket estimates on rolled-up ranges.
	const pLabel = $derived(data.range?.latencySource === 'exact' ? 'P50' : 'P50 (est)');
	const days = [1, 7, 30, 90];
	const rangeHref = (d: number) => `/dashboard/projects/${data.projectId}/analytics?days=${d}`;
</script>

<PageHeader title="Analytics" lede={`Engineering and cost metrics for ${data.projectName || 'this project'}.`} />
<Guide id="analytics" />

<nav class="ranges" aria-label="Time window">
	{#each days as d (d)}
		<ButtonLink href={rangeHref(d)} variant={data.range?.days === d ? 'primary' : 'ghost'}>{d} day{d > 1 ? 's' : ''}</ButtonLink>
	{/each}
</nav>

<UxState
	{state}
	emptyTitle="No traffic in this window"
	emptyHint="Widen the window or send a request — the metrics appear once calls land."
	errorWhat={data.queryError ?? undefined}
	errorWhy="Computing analytics failed on the server."
>
	{#if e && c && data.range}
		<p class="muted">
			Window: {data.range.days} day{data.range.days > 1 ? 's' : ''} · source:
			{data.range.source === 'aggregates' ? 'daily rollup' : 'raw request log'} · percentiles:
			{data.range.latencySource === 'exact' ? 'exact' : 'bucket estimates'}
		</p>

		<Section title="Request volume and quality">
			<div class="stats">
				<StatCard label="Requests" value={formatTokens(e.requestCount)} />
				<StatCard label="Success rate" value={`${e.successRatePct}%`} tone="success" />
				<StatCard label="Error rate" value={`${e.errorRatePct}%`} tone={e.errorRatePct > 0 ? 'danger' : 'neutral'} />
				<StatCard label="Fallback rate" value={`${e.fallbackRatePct}%`} />
				<StatCard label="Retry rate" value={`${e.retryRatePct}%`} />
			</div>
		</Section>

		<Section title="Latency and throughput">
			<div class="stats">
				<StatCard label={pLabel} value={e.p50 == null ? '—' : `${e.p50.toLocaleString()} ms`} />
				<StatCard label={data.range.latencySource === 'exact' ? 'P95' : 'P95 (est)'} value={e.p95 == null ? '—' : `${e.p95.toLocaleString()} ms`} />
				<StatCard
					label={data.range.latencySource === 'exact' ? 'P99' : 'P99 (est)'}
					value={e.p99 == null ? (e.p99Unbounded ? '≥ 60 s' : '—') : `${e.p99.toLocaleString()} ms`}
				/>
				<StatCard label="TTFT (mean)" value={e.ttftMs == null ? '—' : `${e.ttftMs.toLocaleString()} ms`} />
				<StatCard label="Tokens/sec" value={e.tokensPerSecond == null ? '—' : e.tokensPerSecond.toLocaleString()} />
			</div>
		</Section>

		<Section title="Provider and model distribution">
			<TableWrap label="Provider distribution">
				<table class="fr">
					<thead><tr><th>Provider</th><th>Requests</th></tr></thead>
					<tbody>
						{#each e.providerDistribution as d (d.key)}
							<tr><td>{d.label}</td><td class="num">{formatTokens(d.count)}</td></tr>
						{:else}
							<tr><td colspan="2">No requests in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
			<TableWrap label="Model distribution">
				<table class="fr">
					<thead><tr><th>Model</th><th>Requests</th></tr></thead>
					<tbody>
						{#each e.modelDistribution as d (d.key)}
							<tr><td>{d.label}</td><td class="num">{formatTokens(d.count)}</td></tr>
						{:else}
							<tr><td colspan="2">No requests in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		<Section title="Cost analytics" lede="What the customer was charged, from the per-request ledger.">
			<div class="stats">
				<StatCard label="Total spend" value={formatCost(BigInt(c.totalSpendMicro), currency)} />
				<StatCard label="Cost / request" value={formatCost(BigInt(c.costPerRequestMicro), currency)} />
				<StatCard label="Cost / 1M tokens" value={formatCost(BigInt(c.costPer1mTokensMicro), currency)} />
				<StatCard label="Credits charged" value={formatCost(BigInt(c.creditsMicro), currency)} />
				<StatCard
					label="Markup"
					value={c.markupMicro == null ? 'Unknown' : formatCost(BigInt(c.markupMicro), currency)}
				/>
			</div>
			{#if c.providerCostMicro == null}
				<Alert tone="info">
					Provider cost is not reported on this window's rows, so markup cannot be computed. The
					customer charge above is exact.
				</Alert>
			{/if}
		</Section>

		<Section title="Cost by provider">
			<TableWrap label="Cost by provider">
				<table class="fr">
					<thead><tr><th>Provider</th><th>Customer cost</th><th>Provider cost</th></tr></thead>
					<tbody>
						{#each c.byProvider as b (b.key)}
							<tr>
								<td>{b.label}</td>
								<td class="num">{formatCost(BigInt(b.costMicro), currency)}</td>
								<td class="num">{formatCost(BigInt(b.providerCostMicro), currency)}</td>
							</tr>
						{:else}
							<tr><td colspan="3">No spend in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		<Section title="Cost by model">
			<TableWrap label="Cost by model">
				<table class="fr">
					<thead><tr><th>Model</th><th>Customer cost</th><th>Provider cost</th></tr></thead>
					<tbody>
						{#each c.byModel as b (b.key)}
							<tr>
								<td>{b.label}</td>
								<td class="num">{formatCost(BigInt(b.costMicro), currency)}</td>
								<td class="num">{formatCost(BigInt(b.providerCostMicro), currency)}</td>
							</tr>
						{:else}
							<tr><td colspan="3">No spend in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		<Section title="Cost by environment">
			<TableWrap label="Cost by environment">
				<table class="fr">
					<thead><tr><th>Environment</th><th>Customer cost</th><th>Provider cost</th></tr></thead>
					<tbody>
						{#each c.byEnvironment as b (b.key)}
							<tr>
								<td>{b.label}</td>
								<td class="num">{formatCost(BigInt(b.costMicro), currency)}</td>
								<td class="num">{formatCost(BigInt(b.providerCostMicro), currency)}</td>
							</tr>
						{:else}
							<tr><td colspan="3">No spend in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		<Section title="Cost by project">
			<TableWrap label="Cost by project">
				<table class="fr">
					<thead><tr><th>Project</th><th>Customer cost</th><th>Provider cost</th></tr></thead>
					<tbody>
						{#each c.byProject as b (b.key)}
							<tr>
								<td>{b.label}</td>
								<td class="num">{formatCost(BigInt(b.costMicro), currency)}</td>
								<td class="num">{formatCost(BigInt(b.providerCostMicro), currency)}</td>
							</tr>
						{:else}
							<tr><td colspan="3">No spend in this window.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>
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
