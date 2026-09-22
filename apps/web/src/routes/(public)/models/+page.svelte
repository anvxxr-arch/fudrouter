<script lang="ts">
	import { Badge, EmptyState, PageHeader } from '$lib/ui';
	import { BASE_URL, API_SURFACES, API_SURFACE_ORDER, modelsOn, tierTone } from '$lib/catalog';

	let { data } = $props();
</script>

<PageHeader
	title="Models"
	lede="Every model this deployment serves through the [OI]-compatible API, and which surface serves it."
/>

<p class="muted preview">Preview build — the free/premium tiers below are placeholder data.</p>

<!-- Grouped by surface, not by tier: the surface is what a client points at, so it
     is the thing a reader is actually looking for. -->
{#each API_SURFACE_ORDER as surface (surface)}
	{@const meta = API_SURFACES[surface]}
	{@const rows = modelsOn(data.catalog, surface)}
	<section class="surface">
		<header class="surface-head">
			<h2>{meta.label}</h2>
			<code class="endpoint">{BASE_URL}{meta.path}</code>
		</header>
		<p class="muted">{meta.lede}</p>

		<div class="table-wrap">
<table class="fr">
			
				<thead>
					<tr><th>Model</th><th>Slug</th><th>Context</th><th>Tier</th></tr>
				</thead>
				<tbody>
					{#each rows as row (row.model.slug)}
						<tr>
							<td>{row.model.name}</td>
							<td><code>{row.model.slug}</code></td>
							<td class="num">{row.model.context ? row.model.context.toLocaleString() : '—'}</td>
							<td><Badge tone={tierTone(row.tier)}>{row.tier}</Badge></td>
						</tr>
					{:else}
						<tr>
							<td colspan="4"><EmptyState title="No models on this surface yet" /></td>
						</tr>
					{/each}
				</tbody>
			</table></div>
	</section>
{/each}

<style>
	.preview {
		margin: 0 0 var(--fr-space-sm);
		font-size: var(--fr-text-sm);
	}
	.surface {
		margin-top: var(--fr-space-xl);
	}
	.surface-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--fr-space-sm);
	}
	/* h2 carries a global top margin; inside a section header the flex gap sets it. */
	.surface-head h2 {
		margin: 0;
	}
	.endpoint {
		/* A URL has no spaces to break on, and a flex item defaults to
		   `min-width: auto` — so at 320px this pushed the whole page 16px wider than
		   the viewport. Let it shrink, and break inside the word if it must. */
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.surface > p {
		margin: var(--fr-space-xs) 0 var(--fr-space-sm);
		font-size: var(--fr-text-sm);
	}
</style>
