<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import { Alert, Badge, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';

	let { data } = $props();
	const currency = $derived(data.allTime.currency || 'USD');
</script>

<PageHeader title="Billing" lede="What this account has used, and what it is charged for." />

<Alert tone="info">
	This deployment does not bill. No payment method is on file and there is no balance to top up, so
	nothing is charged — the figures below are the metered cost of your calls, kept for reference.
</Alert>

<section class="fr-stats">
	<StatCard label="Spend to date" value={formatCost(BigInt(data.allTime.cost), currency)} />
	<StatCard label="This month" value={formatCost(BigInt(data.month.cost), currency)} />
	<StatCard label="Requests" value={formatTokens(data.allTime.requests)} />
	<StatCard label="Tokens" value={formatTokens(data.allTime.tokensIn + data.allTime.tokensOut)} />
</section>

<h2>Usage by model</h2>
{#if data.byModel.length === 0}
	<EmptyState title="Nothing metered yet" hint="A row appears here after your first logged call." />
{:else}
	<TableWrap label="Usage by model">
		<table class="fr">
			<thead>
				<tr><th>Model</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr>
			</thead>
			<tbody>
				{#each data.byModel as m (m.slug ?? 'unmatched')}
					<tr>
						<td>{m.slug ?? '—'}</td>
						<td class="num">{formatTokens(m.requests)}</td>
						<td class="num">{formatTokens(m.tokensIn)}</td>
						<td class="num">{formatTokens(m.tokensOut)}</td>
						<td class="num">{formatCost(BigInt(m.cost), currency)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	{#if data.modelCount > data.byModel.length}
		<p class="muted">
			Showing the {data.byModel.length} highest-cost of {formatTokens(data.modelCount)} models you have
			used.
		</p>
	{/if}
{/if}

<h2>Recent charges</h2>
<TableWrap label="Recent charges">
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
						><EmptyState
							title="No charges yet"
							hint="Call the API with a key and the rows land here."
						/></td
					></tr
				>
			{/each}
		</tbody>
	</table>
</TableWrap>

<p class="muted">
	The twenty newest rows. Usage lists the newest fifty, with latency and the error string.
</p>

<Guide id="billing" />
