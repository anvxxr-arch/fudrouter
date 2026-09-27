<script lang="ts">
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import { Badge, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';

	let { data } = $props();
</script>

<PageHeader title="Admin overview" lede="Everything happening on this deployment, at a glance." />

<section class="fr-stats">
	<StatCard label="Providers" value={data.providers} />
	<StatCard label="Models" value={data.models} />
	<StatCard label="Active keys" value={data.activeKeys} />
	<StatCard label="Users" value={data.users} />
	<StatCard label="Requests" value={formatTokens(data.totals.requests)} />
	<StatCard label="Tokens" value={formatTokens(data.totals.tokensIn + data.totals.tokensOut)} />
	<StatCard label="Total cost" value={formatCost(BigInt(data.totals.cost))} />
</section>

<Guide id="admin" />

<h2>Top resource consumers (by cost)</h2>
<TableWrap label="Top resource consumers">
	<table class="fr">
		<thead>
			<tr><th>Key</th><th>Owner</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr>
		</thead>
		<tbody>
			{#each data.topKeys as k (k.prefix)}
				<tr>
					<td>{k.name} <code class="muted">sk-ar-{k.prefix}…</code></td>
					<td>{k.email}</td>
					<td class="num">{formatTokens(k.requests)}</td>
					<td class="num">{formatTokens(k.tokens)}</td>
					<td class="num">{formatCost(BigInt(k.cost))}</td>
				</tr>
			{:else}
				<tr><td colspan="5"><EmptyState title="No traffic yet" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>

<h2>Recent requests</h2>
<TableWrap label="Recent requests">
	<table class="fr">
		<thead>
			<tr><th>When</th><th>User</th><th>Model</th><th>Status</th><th>Latency</th><th>Cost</th></tr>
		</thead>
		<tbody>
			{#each data.recent as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.email}</td>
					<td>{r.modelSlug ?? '—'}</td>
					<td><Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge></td>
					<td class="num">{(r.latencyMs ?? 0).toLocaleString()} ms</td>
					<td class="num">{formatCost(r.cost, r.currency)}</td>
				</tr>
			{:else}
				<tr><td colspan="6"><EmptyState title="No requests yet" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
