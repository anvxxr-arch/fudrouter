<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, ButtonLink, EmptyState, PageHeader, Section } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { modelsOn, tierTone } from '$lib/catalog';
	import { formatCost } from '$lib/format';

	let { data } = $props();
	const rows = $derived(modelsOn(data.catalog, 'payg'));
	const per1M = (p: string) => formatCost(BigInt(Math.round(Number(p))));
</script>

<PageHeader title="Pricing" lede="Pay per token — no seat fees. One API key, every model." />

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={280} color="#1A73F2" />
</div>

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
		Coding-plan models are covered by a subscription. That program is not live yet — see <a
			href={resolve('/models')}>Models</a
		> for the preview.
	</p>
</Section>

<div class="cta">
	<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
	<span class="muted">Then mint a key and point a client at the API.</span>
</div>

