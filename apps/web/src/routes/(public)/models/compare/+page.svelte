<script lang="ts">
	import { goto } from '$app/navigation';
	import { Alert, Button, ButtonLink, Field, Guide, PageHeader, Select, TableWrap, UxState } from '$lib/ui';
	import { CAPABILITY_LABELS, effectiveCapability, type CapabilityKey } from '$lib/capabilities';
	import { formatContext, formatMs, formatPricePer1M } from '$lib/public-format';
	import { addToCompare, MAX_COMPARE } from '$lib/compare';
	import type { CatalogModel } from '$lib/server/public-catalog';

	let { data } = $props();

	const columns = $derived(data.columns as CatalogModel[]);

	function capWord(m: CatalogModel, key: CapabilityKey): string {
		const value = effectiveCapability(m.capabilities, {}, key);
		return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
	}

	function query(slugs: string[]): string {
		return '/models/compare?models=' + encodeURIComponent(slugs.join(','));
	}
	// Remove rebuilds the REQUESTED list (data.slugs, order-preserving), not the
	// resolved columns: a "not found" slug stays in the URL, so the muted notice
	// about it does not silently vanish with its neighbour's removal.
	function remove(slug: string): string {
		return query(data.slugs.filter((s: string) => s !== slug));
	}

	// The picker adds one model at a time, rebuilding ?models= via addToCompare
	// (same cap semantics as the catalog's checkboxes).
	let pick = $state('');
	function addModel() {
		if (!pick) return;
		void goto(query(addToCompare(data.slugs, pick)), { noScroll: true });
	}
</script>

<PageHeader title="Compare models" lede="Side by side, one to four models." />
<Guide id="models-compare" />
<!-- The whole point of PRD §16: a neutral fact grid. No ranking, no winner. -->
<p class="muted">
	This is a neutral fact grid — the rows are facts in a fixed order, never a ranking, and no model
	is highlighted as better.
</p>

{#if data.truncated}
	<div class="fr-feedback">
		<Alert tone="info">
			Only the first {MAX_COMPARE} models are compared — the rest of the selection was ignored.
		</Alert>
	</div>
{/if}
{#if data.missing.length > 0}
	<ul class="missing">
		{#each data.missing as slug (slug)}
			<li class="muted">not found: {slug}</li>
		{/each}
	</ul>
{/if}

<form
	class="picker"
	onsubmit={(e: SubmitEvent) => {
		e.preventDefault();
		addModel();
	}}
>
	<Field label="Add a model">
		<Select value={pick} onchange={(e: Event) => (pick = (e.currentTarget as HTMLSelectElement).value)}>
			<option value="" disabled={pick !== ''}>Choose a model…</option>
			{#each data.options as opt (opt.slug)}
				<option value={opt.slug} disabled={data.slugs.includes(opt.slug)}>{opt.name}</option>
			{/each}
		</Select>
	</Field>
	<Button type="submit" disabled={!pick || data.slugs.length >= MAX_COMPARE}>Add</Button>
</form>

{#if columns.length === 0}
	<UxState
		state="empty"
		emptyTitle="No models selected yet"
		emptyHint="Pick up to four models above to compare them side by side."
	/>
{:else}
	<TableWrap label="Model comparison">
		<table class="fr">
			<thead>
				<tr>
					<th><span class="sr-only">Fact</span></th>
					{#each columns as m (m.slug)}
						<th>
							<a href={'/models/' + encodeURIComponent(m.slug)}>{m.name}</a>
							<br />
							<a class="remove" href={remove(m.slug)}>remove</a>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row">Developer</th>
					{#each columns as m (m.slug)}<td>{m.developer ?? 'Unknown'}</td>{/each}
				</tr>
				<tr>
					<th scope="row">Context</th>
					{#each columns as m (m.slug)}<td class="num">{formatContext(m.context)}</td>{/each}
				</tr>
				<tr>
					<th scope="row">Input price</th>
					{#each columns as m (m.slug)}
						<td class="num">{formatPricePer1M(m.price.inputPriceMicro, m.price.currency)}</td>
					{/each}
				</tr>
				<tr>
					<th scope="row">Output price</th>
					{#each columns as m (m.slug)}
						<td class="num">{formatPricePer1M(m.price.outputPriceMicro, m.price.currency)}</td>
					{/each}
				</tr>
				{#each ['vision', 'tools', 'reasoning', 'structured_output', 'streaming'] as key (key)}
					<tr>
						<th scope="row">{CAPABILITY_LABELS[key as CapabilityKey]}</th>
						{#each columns as m (m.slug)}<td>{capWord(m, key as CapabilityKey)}</td>{/each}
					</tr>
				{/each}
				<tr>
					<th scope="row">Provider count</th>
					{#each columns as m (m.slug)}<td class="num">{m.providers.length}</td>{/each}
				</tr>
				<tr>
					<th scope="row">Observed P50</th>
					{#each columns as m (m.slug)}<td class="num">{formatMs(m.p50Ms)}</td>{/each}
				</tr>
				<tr>
					<th scope="row">Observed P95</th>
					{#each columns as m (m.slug)}<td class="num">{formatMs(m.p95Ms)}</td>{/each}
				</tr>
			</tbody>
		</table>
	</TableWrap>
	{#if data.slugs.length < MAX_COMPARE && data.options.length > data.slugs.length}
		<p class="muted">
			Up to {MAX_COMPARE} models compare at once — add another above.
			<ButtonLink variant="ghost" href="/models">Back to the catalog</ButtonLink>
		</p>
	{/if}
{/if}

<style>
	.picker {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	.picker :global(.field) {
		min-width: 14rem;
	}
	.missing {
		list-style: none;
		margin: 0 0 var(--space-md);
		padding: 0;
	}
	.remove {
		font-size: var(--text-caption);
		color: var(--color-text-muted);
	}
</style>
