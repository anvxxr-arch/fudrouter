<script lang="ts">
	import { formatCost, formatTokens } from '$lib/format';
	import {
		Alert,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		TableWrap
	} from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader
	title="Analytics"
	lede="Usage rolled up by model and provider — requests, tokens, cost and latency percentiles."
/>
{#if !data.usingRollups}
	<div class="fr-feedback">
		<Alert tone="info">
			Rollup tables are empty for this window — showing request_log aggregation.
		</Alert>
	</div>
{/if}
<form class="filters" method="GET">
	<Field label="From"><Input name="from" type="date" value={data.from} /></Field>
	<Field label="To"><Input name="to" type="date" value={data.to} /></Field>
	<Button type="submit">Apply</Button>
</form>
<Guide id="admin-analytics" />
<Card>
	<h2 class="first">By model</h2>
	<TableWrap label="Usage by model">
		<table class="fr">
			<thead>
				<tr
					><th>Model</th><th>Requests</th><th>Successes</th><th>Tokens in</th><th>Tokens out</th
					><th>Cost</th><th>P50</th><th>P95</th><th>P99</th></tr
				>
			</thead>
			<tbody>
				{#each data.byModel as m (m.id)}
					<tr>
						<td><code>{m.name}</code></td>
						<td class="num">{formatTokens(m.requests)}</td>
						<td class="num">{formatTokens(m.successes)}</td>
						<td class="num">{formatTokens(m.tokensIn)}</td>
						<td class="num">{formatTokens(m.tokensOut)}</td>
						<td class="num">{formatCost(BigInt(m.costMicro))}</td>
						<td class="num">{m.p50.toLocaleString()} ms</td>
						<td class="num">{m.p95.toLocaleString()} ms</td>
						<td class="num">{m.p99.toLocaleString()} ms</td>
					</tr>
				{:else}
					<tr><td colspan="9"><EmptyState title="No usage in this window" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="first">By provider</h2>
	<TableWrap label="Usage by provider">
		<table class="fr">
			<thead>
				<tr
					><th>Provider</th><th>Requests</th><th>Successes</th><th>Tokens in</th><th>Tokens out</th
					><th>Cost</th><th>P50</th><th>P95</th><th>P99</th></tr
				>
			</thead>
			<tbody>
				{#each data.byProvider as p (p.id)}
					<tr>
						<td>{p.name}</td>
						<td class="num">{formatTokens(p.requests)}</td>
						<td class="num">{formatTokens(p.successes)}</td>
						<td class="num">{formatTokens(p.tokensIn)}</td>
						<td class="num">{formatTokens(p.tokensOut)}</td>
						<td class="num">{formatCost(BigInt(p.costMicro))}</td>
						<td class="num">{p.p50.toLocaleString()} ms</td>
						<td class="num">{p.p95.toLocaleString()} ms</td>
						<td class="num">{p.p99.toLocaleString()} ms</td>
					</tr>
				{:else}
					<tr><td colspan="9"><EmptyState title="No usage in this window" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<style>
	.filters {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		margin: var(--space-md) 0;
	}
</style>
