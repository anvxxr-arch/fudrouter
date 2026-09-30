<script lang="ts">
	import { formatTokens } from '$lib/format';
	import { Alert, Card, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
	function bytes(n: number | null): string {
		if (n === null) return 'unavailable';
		if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GiB`;
		if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MiB`;
		if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(2)} KiB`;
		return `${n} B`;
	}
	const maxNamespace = $derived(
		Math.max(1, ...data.namespaces.map((n: { count: number }) => n.count))
	);
</script>

<PageHeader
	title="Valkey"
	lede="The cache and counter layer. Losing it loses no business data — PostgreSQL is authoritative."
/>
<Guide id="admin-system-valkey" />
{#if !data.configured}
	<Alert tone="info">Valkey not configured (VALKEY_URL unset) — every metric below is unavailable.</Alert>
{/if}
<div class="fr-stats">
	<StatCard
		label="PING latency"
		value={data.latencyMs === null ? 'unavailable' : `${data.latencyMs.toFixed(2)} ms`}
		tone={data.latencyMs === null ? 'neutral' : 'success'}
	/>
	<StatCard label="DBSIZE" value={data.dbsize === null ? 'unavailable' : formatTokens(data.dbsize)} />
	<StatCard label="used_memory" value={bytes(data.info.usedMemory)} />
	<StatCard
		label="maxmemory"
		value={data.info.maxMemory === 0 ? 'unlimited' : bytes(data.info.maxMemory)}
	/>
	<StatCard label="connected_clients" value={data.info.connectedClients ?? 'unavailable'} />
	<StatCard label="ops/sec" value={data.info.opsPerSec ?? 'unavailable'} />
	<StatCard
		label="Hit rate"
		value={data.info.hitRate === null ? 'unavailable' : `${data.info.hitRate.toFixed(2)}%`}
	/>
	<StatCard label="evicted_keys" value={data.info.evictedKeys ?? 'unavailable'} />
</div>
<Card>
	<h2 class="fr-label">Logical usage by namespace</h2>
	{#if !data.configured}
		<p class="muted">unavailable</p>
	{:else}
		<p class="muted">
			Key counts by first-segment prefix (spec §12). Sampled with SCAN up to
			{formatTokens(data.sampled)} keys — a sample, not an exact census.
		</p>
		<TableWrap label="Key counts by namespace">
			<table class="fr">
				<thead><tr><th>Namespace</th><th>Sampled keys</th><th></th></tr></thead>
				<tbody>
					{#each data.namespaces as n (n.prefix)}
						<tr>
							<td>{n.prefix}:…</td>
							<td class="num">{formatTokens(n.count)}</td>
							<td><span class="bar" style="width: {(100 * n.count) / maxNamespace}%"></span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}
</Card>
<style>
	.bar {
		display: block;
		height: 8px;
		background: var(--color-info);
		border-radius: var(--radius-pill);
		min-width: 2px;
	}
</style>
