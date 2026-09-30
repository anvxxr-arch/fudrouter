<script lang="ts">
	import { Badge, Card, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader
	title="Routing strategies"
	lede="The nine strategies and the inputs each one mixes. The full explainer lives in the guide below."
/>
<Guide id="admin-routing-strategies" />
<Card>
	<h2 class="first">Strategy reference</h2>
	<TableWrap label="Strategy reference">
		<table class="fr">
			<thead><tr><th>Strategy</th><th>Uses</th></tr></thead>
			<tbody>
				{#each data.strategies as s (s.key)}
					<tr>
						<td><code>{s.key}</code></td>
						<td>{s.uses}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="fr-label">Weights in effect (per policy)</h2>
	<TableWrap label="Policy weights">
		<table class="fr">
			<thead><tr><th>Policy</th><th>Strategy</th><th>weights jsonb</th></tr></thead>
			<tbody>
				{#each data.policies as p (p.id)}
					<tr>
						<td>{p.name}</td>
						<td><Badge tone="neutral"><code>{p.strategy}</code></Badge></td>
						<td><code class="weights">{JSON.stringify(p.weights ?? {})}</code></td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No routing policies yet" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<style>
	h2.first {
		margin-top: 0;
	}
	.weights {
		font-size: var(--text-sm);
	}
</style>
