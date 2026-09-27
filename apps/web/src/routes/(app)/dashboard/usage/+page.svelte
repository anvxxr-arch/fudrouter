<script lang="ts">
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { Badge, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';

	let { data } = $props();
</script>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={220} color="#3B82F4" />
</div>
<PageHeader title="Usage" lede="Requests routed for your account, newest first." />

<section class="fr-stats">
	<StatCard label="Requests" value={formatTokens(data.totals.requests)} />
	<StatCard label="Tokens in" value={formatTokens(data.totals.tokensIn)} />
	<StatCard label="Tokens out" value={formatTokens(data.totals.tokensOut)} />
	<StatCard label="Cost" value={formatCost(BigInt(data.totals.cost))} />
</section>

<Guide id="usage" />

<h2>Requests</h2>
<TableWrap label="Requests">
	<table class="fr">
		<thead>
			<tr
				><th>When</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>Latency</th><th
					>Status</th
				></tr
			>
		</thead>
		<tbody>
			{#each data.recent as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.modelSlug ?? '—'}</td>
					<td class="num">{formatTokens(r.tokensIn)}</td>
					<td class="num">{formatTokens(r.tokensOut)}</td>
					<td class="num">{formatCost(r.cost, r.currency)}</td>
					<td class="num">{(r.latencyMs ?? 0).toLocaleString()} ms</td>
					<td>
						<Badge tone={r.status === 'success' ? 'success' : 'danger'}>
							{r.status}{r.error ? `: ${r.error}` : ''}
						</Badge>
					</td>
				</tr>
			{:else}
				<tr><td colspan="7"><EmptyState title="No requests yet" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>

{#if data.totals.requests > data.recent.length}
	<p class="muted">
		Showing the {data.recent.length} newest of {formatTokens(data.totals.requests)} — this table is capped,
		the totals above are not.
	</p>
{/if}
