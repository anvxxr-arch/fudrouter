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
							<h4>{row.model.name}</h4>
							<Badge tone={tierTone(row.tier)}>{row.tier}</Badge>
						</header>
						<code class="slug">{row.model.slug}</code>
						{#if row.model.context}
							<span class="context num">{(row.model.context / 1000).toFixed(0)}k context</span>
						{/if}
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
		gap: var(--fr-space-md);
	}
	.surface-card {
		display: grid;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-md);
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
		gap: var(--fr-space-md);
	}
	.model-card {
		display: grid;
		gap: var(--fr-space-sm);
		padding: var(--fr-space-md);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.model-card header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--fr-space-sm);
	}
	.model-card h4 {
		margin: 0;
		font-size: var(--fr-text-base);
		font-weight: 600;
	}
	.slug {
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.context {
		font-size: var(--fr-text-sm);
		color: var(--fr-text-muted);
	}
</style>
