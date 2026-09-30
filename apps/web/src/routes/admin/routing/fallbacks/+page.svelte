<script lang="ts">
	import { Badge, Card, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader
	title="Fallbacks & retry"
	lede="Retry posture per policy, and the error-code split: transient failures retry, caller errors never do."
/>
<Guide id="admin-routing-fallbacks" />
<Card>
	<h2 class="first">Retry semantics</h2>
	<div class="cols">
		<div>
			<h3 class="fr-label">Retry on</h3>
			<div class="codes">
				{#each data.retryable as code (code)}
					<Badge tone="warning">{code}</Badge>
				{/each}
			</div>
		</div>
		<div>
			<h3 class="fr-label">Never retry</h3>
			<div class="codes">
				{#each data.neverRetry as code (code)}
					<Badge tone="danger">{code}</Badge>
				{/each}
			</div>
		</div>
	</div>
</Card>
<TableWrap label="Retry posture per policy">
	<table class="fr">
		<thead>
			<tr><th>Policy</th><th>Max attempts</th><th>Fallback</th><th>Status</th></tr>
		</thead>
		<tbody>
			{#each data.policies as p (p.id)}
				<tr>
					<td>{p.name}</td>
					<td class="num">{p.maxAttempts}</td>
					<td><Badge tone={p.fallbackEnabled ? 'success' : 'neutral'}>{p.fallbackEnabled ? 'on' : 'off'}</Badge></td>
					<td><Badge tone={p.enabled ? 'success' : 'warning'}>{p.enabled ? 'enabled' : 'disabled'}</Badge></td>
				</tr>
			{:else}
				<tr><td colspan="4"><EmptyState title="No routing policies yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	h2.first {
		margin-top: 0;
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-lg);
	}
	.codes {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
</style>
