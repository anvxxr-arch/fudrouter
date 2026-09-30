<script lang="ts">
	import { formatTokens } from '$lib/format';
	import { Card, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
	const maxHourly = $derived(Math.max(1, ...data.hourly.map((h: { requests: number }) => h.requests)));
	function ms(v: number | null): string {
		return v === null ? '—' : `${Math.round(v).toLocaleString()} ms`;
	}
</script>

<PageHeader
	title="Metrics"
	lede="Request volume, error mix and latency percentiles over the last 24 hours."
/>
<Guide id="admin-system-metrics" />
<div class="fr-stats">
	<StatCard label="Requests (24h)" value={formatTokens(data.fallback.requests)} />
	<StatCard label="Fallback rate" value={data.fallback.rate === null ? '—' : `${data.fallback.rate.toFixed(2)}%`} />
	<StatCard label="Latency P50" value={ms(data.latency.p50)} />
	<StatCard label="Latency P95" value={ms(data.latency.p95)} />
	<StatCard label="Latency P99" value={ms(data.latency.p99)} />
	<StatCard label="TTFT P50" value={ms(data.latency.ttftP50)} />
	<StatCard label="TTFT P95" value={ms(data.latency.ttftP95)} />
</div>
<div class="grid2">
	<Card>
		<h2 class="fr-label">Requests per hour</h2>
		<TableWrap label="Requests per hour">
			<table class="fr">
				<thead>
					<tr><th>Hour (UTC)</th><th>Requests</th><th>Successes</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.hourly as h (h.bucket)}
						<tr>
							<td class="num">{h.bucket}</td>
							<td class="num">{h.requests.toLocaleString()}</td>
							<td class="num">{h.successes.toLocaleString()}</td>
							<td><span class="bar" style="width: {(100 * h.requests) / maxHourly}%"></span></td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No requests in the last 24 hours" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
	<Card>
		<h2 class="fr-label">Error mix</h2>
		<TableWrap label="Error mix by status and error code">
			<table class="fr">
				<thead><tr><th>Status</th><th>Error code</th><th>Requests</th></tr></thead>
				<tbody>
					{#each data.errorMix as e (e.status + e.errorCode)}
						<tr>
							<td>{e.status}</td>
							<td>{e.errorCode || '—'}</td>
							<td class="num">{e.requests.toLocaleString()}</td>
						</tr>
					{:else}
						<tr><td colspan="3"><EmptyState title="No errors in the last 24 hours" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
</div>
<TableWrap label="Per-provider metrics">
	<table class="fr">
		<thead>
			<tr><th>Provider</th><th>Requests</th><th>Successes</th><th>Latency P50</th><th>Latency P95</th></tr>
		</thead>
		<tbody>
			{#each data.perProvider as p (p.providerId)}
				<tr>
					<td>{p.providerName}</td>
					<td class="num">{p.requests.toLocaleString()}</td>
					<td class="num">{p.successes.toLocaleString()}</td>
					<td class="num">{ms(p.p50)}</td>
					<td class="num">{ms(p.p95)}</td>
				</tr>
			{:else}
				<tr><td colspan="5"><EmptyState title="No per-provider traffic in the last 24 hours" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	.bar {
		display: block;
		height: 8px;
		background: var(--color-info);
		border-radius: var(--radius-pill);
		min-width: 2px;
	}
</style>
