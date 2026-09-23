<script lang="ts">
	import { Alert, Badge, EmptyState, Guide, PageHeader, Section } from '$lib/ui';
	import { BASE_URL, API_SURFACES, API_SURFACE_ORDER, modelsOn, tierTone } from '$lib/catalog';

	let { data } = $props();
</script>

<PageHeader
	title="Models"
	lede="Every model this deployment serves through the [OI]-compatible API."
/>

<div class="fr-feedback">
	<Alert tone="warning">Preview build — the free and premium badges below are placeholder data, not billing.</Alert>
</div>

<Section title="Surfaces" lede="A surface is the path prefix your client points at.">
	<div class="surface-grid">
		{#each API_SURFACE_ORDER as surface (surface)}
			{@const meta = API_SURFACES[surface]}
			<article class="surface-card">
				<header>
					<h3>{meta.label}</h3>
					<code class="endpoint">{BASE_URL}{meta.path}</code>
				</header>
				<p class="muted">{meta.lede}</p>
			</article>
		{/each}
	</div>
</Section>

{#each API_SURFACE_ORDER as surface (surface)}
	{@const meta = API_SURFACES[surface]}
	{@const rows = modelsOn(data.catalog, surface)}
	<Section title={meta.label} lede="{modelsOn(data.catalog, surface).length} models on this surface.">
		{#if rows.length === 0}
			<EmptyState title="No models on this surface yet" />
		{:else}
			<div class="model-grid">
				{#each rows as row (row.model.slug)}
					<article class="model-card">
						<header>
							<h3>{row.model.name}</h3>
							<Badge tone={tierTone(row.tier)}>{row.tier}</Badge>
						</header>
						<!-- The metadata block is pinned to the card's bottom, so it lines up
						     across a row whatever the title wraps to. -->
						<div class="meta">
							<!-- The slug is printed only when it is NOT the title. It is the
							     same string as the name on 238 of 243 models, so printing both
							     duplicated every card and doubled the title's wrap cost. -->
							{#if row.model.slug !== row.model.name}
								<code class="slug">{row.model.slug}</code>
							{/if}
							{#if row.model.context}
								<span class="context num">{(row.model.context / 1000).toFixed(0)}k context</span>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</Section>
{/each}

<Guide id="models" />

<style>
	.surface-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--fr-space-lg);
	}
	.surface-card {
		display: grid;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-card);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.surface-card header {
		display: grid;
		gap: var(--fr-space-xs);
	}
	.surface-card h3 {
		margin: 0;
		font-size: var(--fr-text-h5);
		font-weight: 600;
	}
	.endpoint {
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
		word-break: break-all;
	}
	.model-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: var(--fr-space-lg);
	}
	.model-card {
		/* Flex column, not grid: the trailing block needs `margin-top: auto` to sit
		   on the card's bottom edge. In a row of stretched cards, a title that wraps
		   one line more would otherwise push everything after it down. */
		display: flex;
		flex-direction: column;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-card);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.model-card header {
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
	.model-card h3 {
		margin: 0;
		font-size: var(--fr-text-base);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		display: grid;
		gap: var(--fr-space-xs);
		justify-items: start;
		margin-top: auto;
	}
	.slug {
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
		overflow-wrap: anywhere;
	}
	.context {
		font-size: var(--fr-text-sm);
		color: var(--fr-text-muted);
	}
</style>
