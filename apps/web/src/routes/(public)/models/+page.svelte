<script lang="ts">
	import { Alert, Badge, EmptyState, PageHeader, Section } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { BASE_URL, API_SURFACES, API_SURFACE_ORDER, modelsOn, tierTone } from '$lib/catalog';

	let { data } = $props();
</script>

<PageHeader
	title="Models"
	lede="Every model this deployment serves through the [OI]-compatible API."
/>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={260} color="#3B82F4" />
</div>

<div class="fr-feedback">
	<Alert tone="warning"
		>Preview build — the free and premium badges below are placeholder data, not billing.</Alert
	>
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
	<Section
		title={meta.label}
		lede="{modelsOn(data.catalog, surface).length} models on this surface."
	>
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

