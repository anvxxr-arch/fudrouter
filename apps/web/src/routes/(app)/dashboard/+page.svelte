<script lang="ts">
	import { resolve } from '$app/paths';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import {formatCost, formatTokens, formatDateTime} from '$lib/format';
	import { Badge, EmptyState, Guide, PageHeader, StatCard, UsageChart, TableWrap } from '$lib/ui';

	let { data } = $props();
</script>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={220} color="#3B82F4" />
</div>
<PageHeader
	title="Dashboard"
	lede="Your usage at a glance. Everything below is scoped to your account."
/>

<section class="fr-stats">
	<StatCard label="Active keys" value={data.activeKeys} />
	<StatCard label="Requests" value={formatTokens(data.totals.requests)} />
	<StatCard label="Tokens" value={formatTokens(data.totals.tokensIn + data.totals.tokensOut)} />
	<StatCard label="Spend" value={formatCost(BigInt(data.totals.cost))} />
</section>

<h2>Activity — last 14 days</h2>
{#if data.series.some((d) => d.requests > 0)}
	<UsageChart days={data.series} />
{:else}
	<EmptyState title="No calls yet" hint="The chart fills in from your first API call." />
{/if}

<Guide id="dashboard" />

<p class="muted">
	Manage keys under <a href={resolve('/dashboard/keys')}>API Keys</a>. Metered cost, per model, is on
	<a href={resolve('/dashboard/billing')}>Billing</a>.
</p>

<h2>Recent requests</h2>
<TableWrap label="Recent requests">
<table class="fr">
	
		<thead>
			<tr><th>When</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>Status</th></tr>
		</thead>
		<tbody>
			{#each data.recent as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.modelSlug ?? '—'}</td>
					<td class="num">{formatTokens(r.tokensIn)}</td>
					<td class="num">{formatTokens(r.tokensOut)}</td>
					<td class="num">{formatCost(r.cost, r.currency)}</td>
					<td><Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge></td>
				</tr>
			{:else}
				<tr
					><td colspan="6"
						><EmptyState title="No requests yet" hint="Mint a key and call the API." /></td
					></tr
				>
			{/each}
		</tbody>
</table></TableWrap>


