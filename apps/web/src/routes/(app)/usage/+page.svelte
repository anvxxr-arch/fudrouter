<script lang="ts">
	import { formatCost, formatTokens } from '$lib/format';
	let { data } = $props();
</script>

<h1>Usage</h1>

<section class="totals">
	<div><span>Requests</span><strong>{formatTokens(data.totals.requests)}</strong></div>
	<div><span>Tokens in</span><strong>{formatTokens(data.totals.tokensIn)}</strong></div>
	<div><span>Tokens out</span><strong>{formatTokens(data.totals.tokensOut)}</strong></div>
	<div><span>Cost</span><strong>{formatCost(BigInt(data.totals.cost))}</strong></div>
</section>

<table>
	<thead>
		<tr><th>When</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>Latency</th><th>Status</th></tr>
	</thead>
	<tbody>
		{#each data.recent as r (r.id)}
			<tr>
				<td>{r.createdAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
				<td>{r.modelSlug ?? '—'}</td>
				<td>{formatTokens(r.tokensIn)}</td>
				<td>{formatTokens(r.tokensOut)}</td>
				<td>{formatCost(r.cost, r.currency)}</td>
				<td>{r.latencyMs} ms</td>
				<td class:err={r.status !== 'success'}>{r.status}{r.error ? `: ${r.error}` : ''}</td>
			</tr>
		{:else}
			<tr><td colspan="7">No requests yet.</td></tr>
		{/each}
	</tbody>
</table>

<style>
	.totals {
		display: flex;
		gap: 2rem;
		margin: 1rem 0;
	}
	.totals div {
		display: grid;
	}
	.totals span {
		font-size: 0.8rem;
		opacity: 0.7;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid #333;
	}
	.err {
		color: #e66;
	}
</style>
