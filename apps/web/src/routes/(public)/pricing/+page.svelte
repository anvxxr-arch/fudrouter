<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, ButtonLink, EmptyState, Guide, PageHeader, Section } from '$lib/ui';
	import { modelsOn, tierTone } from '$lib/catalog';
	import { formatCost } from '$lib/format';

	let { data } = $props();
	const rows = $derived(modelsOn(data.catalog, 'payg'));
	const per1M = (p: string) => formatCost(BigInt(Math.round(Number(p))));
</script>

<PageHeader
	title="Pricing"
	lede="Pay per token — no seat fees. One API key, every model."
/>

<Section title="Pay-as-you-go" lede="Prices are per 1M tokens. Input and output are priced apart.">
	{#if rows.length === 0}
		<EmptyState title="No models published yet" />
	{:else}
		<div class="pricing-grid">
			{#each rows as row (row.model.slug)}
				<article class="price-card">
					<header>
						<h3>{row.model.name}</h3>
						<Badge tone={tierTone(row.tier)}>{row.tier}</Badge>
					</header>
					<!-- Printed only when it is NOT the title: on 238 of 243 models the
					     slug and the display name are the same string, so both lines
					     duplicated the card. -->
					{#if row.model.slug !== row.model.name}
						<code class="slug">{row.model.slug}</code>
					{/if}
					<!-- Pinned to the card's bottom so the three rows line up across a
					     row whatever the title wraps to. Context is always rendered —
					     it is absent on half the catalog, and an optional row made half
					     the cards two rows tall and half three. -->
					<div class="prices">
						<div class="price-row">
							<span class="fr-label">Input</span>
							<span class="price num">{per1M(row.model.inputPrice)}</span>
						</div>
						<div class="price-row">
							<span class="fr-label">Output</span>
							<span class="price num">{per1M(row.model.outputPrice)}</span>
						</div>
						<div class="price-row">
							<span class="fr-label">Context</span>
							<span class="num"
								>{row.model.context ? `${(row.model.context / 1000).toFixed(0)}k` : '—'}</span
							>
						</div>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</Section>

<Section title="Coding plan" lede="Included in a subscription instead of billed per token.">
	<p class="muted">
		Coding-plan models are covered by a subscription. That program is not live yet —
		see <a href={resolve('/models')}>Models</a> for the preview.
	</p>
</Section>

<div class="cta">
	<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
	<span class="muted">Then mint a key and point a client at the API.</span>
</div>

<Guide id="pricing" />

<style>
	.pricing-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--fr-space-lg);
	}
	.price-card {
		/* Flex column, not grid: the price block needs `margin-top: auto` to sit on
		   the card's bottom edge (see the markup comment). */
		display: flex;
		flex-direction: column;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-card);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.price-card header {
		display: flex;
		/* Top-aligned, not centred: the badge must sit at the same offset from the
		   card's top edge in every card. Centring it against the title made it
		   drift down by a line whenever a long slug wrapped one line further. */
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--fr-space-sm);
		/* long model names must wrap, not push the badge past the card
		   (WCAG 1.4.10 at 320px) */
		min-width: 0;
	}
	.price-card h3 {
		margin: 0;
		font-size: var(--fr-text-base);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.slug {
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
		overflow-wrap: anywhere;
	}
	.prices {
		display: grid;
		gap: var(--fr-space-sm);
		margin-top: auto;
	}
	.price-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--fr-space-sm);
	}
	.price {
		font-size: var(--fr-text-h5);
		font-weight: 700;
	}
	.cta {
		display: flex;
		align-items: center;
		gap: var(--fr-space-md);
		margin-top: var(--fr-space-xl);
	}
</style>
