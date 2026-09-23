<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, ButtonLink, EmptyState, Guide, PageHeader } from '$lib/ui';
	import { modelsOn, tierTone } from '$lib/catalog';
	import { formatCost } from '$lib/format';

	let { data } = $props();
	// This page is the per-token list, so it shows the PAYG surface only — a model
	// that is not served on /v1 has no per-token price to quote.
	const rows = $derived(modelsOn(data.catalog, 'payg'));
	// Prices are stored in micro-units per 1M tokens; formatCost renders them.
	const per1M = (p: string) => formatCost(BigInt(Math.round(Number(p))));
</script>

<PageHeader
	title="Pricing"
	lede="Pay per token — no seat fees. One API key, every model. Prices are per 1M tokens."
/>

<Guide id="pricing" />

<div class="table-wrap">
<table class="fr">
	
		<thead>
			<tr><th>Model</th><th>Context</th><th>Tier</th><th>Input / 1M</th><th>Output / 1M</th></tr>
		</thead>
		<tbody>
			{#each rows as row (row.model.slug)}
				<tr>
					<td>{row.model.name} <code class="muted">{row.model.slug}</code></td>
					<td class="num"
						>{row.model.context ? `${(row.model.context / 1000).toFixed(0)}k` : '—'}</td
					>
					<td><Badge tone={tierTone(row.tier)}>{row.tier}</Badge></td>
					<td class="num">{per1M(row.model.inputPrice)}</td>
					<td class="num">{per1M(row.model.outputPrice)}</td>
				</tr>
			{:else}
				<tr><td colspan="5"><EmptyState title="No models published yet" /></td></tr>
			{/each}
		</tbody>
	</table></div>

<p class="muted note">
	Coding-plan models are included in a subscription instead of billed per token — see
	<a href={resolve('/models')}>Models</a> for which surface serves what.
</p>

<div class="cta">
	<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
	<span class="muted">Then mint a key and point a client at the API.</span>
</div>

<style>
	.note {
		margin-top: var(--fr-space-md);
		font-size: var(--fr-text-sm);
	}
	.cta {
		display: flex;
		align-items: center;
		gap: var(--fr-space-md);
		margin-top: var(--fr-space-lg);
	}
</style>
