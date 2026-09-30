<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Badge, Button, ButtonLink, Field, Guide, Input, PageHeader, Select, TableWrap, UxState } from '$lib/ui';
	import {
		CAPABILITIES,
		CAPABILITY_LABELS,
		effectiveCapability,
		type CapabilityKey
	} from '$lib/capabilities';
	import { formatContext, formatPricePer1M } from '$lib/public-format';
	import type { CatalogModel } from '$lib/server/public-catalog';
	import type { SortKey } from '$lib/model-catalog';
	import { addToCompare, MAX_COMPARE } from '$lib/compare';
	let { data } = $props();

	/**
	 * Rollup of provider mapping status (PRD §14): any 'available' mapping serves
	 * the model; mappings exist but none is 'available' = degraded. No mapping at
	 * all cannot appear — servedModels drops unserved models.
	 */
	function statusRollup(m: CatalogModel): {
		label: string;
		tone: 'success' | 'warning' | 'danger';
	} {
		if (m.providers.some((p) => p.status === 'available'))
			return { label: 'Available', tone: 'success' };
		if (m.providers.some((p) => p.status === 'degraded')) return { label: 'Degraded', tone: 'warning' };
		return { label: 'Unavailable', tone: 'danger' };
	}

	/** TRUE capabilities only — an unknown is not shown as "no", it is simply absent. */
	function trueCaps(m: CatalogModel): CapabilityKey[] {
		return CAPABILITIES.filter((key) => effectiveCapability(m.capabilities, {}, key) === true);
	}

	// The compare selection lives in ?compare=a,b,c so it is shareable and
	// survives a filter submit (the form carries it in a hidden field).
	const selected = $derived(data.selected);
	const compareHref = $derived(
		selected.length > 0 ? '/models/compare?models=' + encodeURIComponent(selected.join(',')) : '/models/compare'
	);
	function toggle(slug: string, on: boolean) {
		let next: string[];
		if (on) {
			next = addToCompare(selected, slug);
		} else {
			next = selected.filter((s) => s !== slug);
		}
		const url = new URL(page.url);
		if (next.length > 0) url.searchParams.set('compare', next.join(','));
		else url.searchParams.delete('compare');
		void goto(url, { keepFocus: true, noScroll: true });
	}

	const SORTS: { value: SortKey; label: string }[] = [
		{ value: 'name', label: 'Name' },
		{ value: 'input-price', label: 'Input price' },
		{ value: 'output-price', label: 'Output price' },
		{ value: 'context', label: 'Context' },
		{ value: 'popularity', label: 'Popularity' },
		{ value: 'latency', label: 'Latency' },
		{ value: 'availability', label: 'Availability' }
	];
	const TRISTATE: { value: 'any' | 'yes' | 'no'; label: string }[] = [
		{ value: 'any', label: 'Any' },
		{ value: 'yes', label: 'Yes' },
		{ value: 'no', label: 'No' }
	];
	const CAP_FILTERS: CapabilityKey[] = [
		'vision',
		'tools',
		'reasoning',
		'structured_output',
		'streaming'
	];
</script>

<PageHeader
	title="Models"
	lede="Every model this deployment serves through the [OI]-compatible API."
/>
<Guide id="models" />

<form method="GET" class="filters">
	<Field label="Search">
		<Input
			type="search"
			name="search"
			value={data.form.search}
			placeholder="name, slug, developer"
		/>
	</Field>
	<Field label="Developer">
		<Select name="developer">
			<option value="">All developers</option>
			{#each data.options.developers as dev (dev)}
				<option value={dev} selected={dev === data.form.developer}>{dev}</option>
			{/each}
		</Select>
	</Field>
	<Field label="Provider">
		<Select name="provider">
			<option value="">All providers</option>
			{#each data.options.providers as p (p)}
				<option value={p} selected={p === data.form.provider}>{p}</option>
			{/each}
		</Select>
	</Field>
	<Field label="Min context (k tokens)">
		<Input type="number" name="minContext" min="0" value={data.form.minContext} />
	</Field>
	<Field label="Max input price (per 1M)">
		<Input type="text" name="maxInputPrice" inputmode="decimal" value={data.form.maxInputPrice} placeholder="e.g. 1.25" />
	</Field>
	<Field label="Max output price (per 1M)">
		<Input type="text" name="maxOutputPrice" inputmode="decimal" value={data.form.maxOutputPrice} placeholder="e.g. 5" />
	</Field>
	<Field label="Sort by">
		<Select name="sort">
			{#each SORTS as s (s.value)}
				<option value={s.value} selected={s.value === data.sort}>{s.label}</option>
			{/each}
		</Select>
	</Field>
	<fieldset class="caps">
		<legend class="fr-label">Requires</legend>
		{#each CAP_FILTERS as key (key)}
			<Field label={CAPABILITY_LABELS[key]}>
				<Select name={key}>
					{#each TRISTATE as t (t.value)}
						<option value={t.value} selected={(data.form[key] ?? 'any') === t.value}>{t.label}</option>
					{/each}
				</Select>
			</Field>
		{/each}
	</fieldset>
	{#if selected.length > 0}
		<input type="hidden" name="compare" value={selected.join(',')} />
	{/if}
	<div class="submit">
		<Button type="submit" variant="primary">Apply filters</Button>
		<ButtonLink variant="ghost" href="/models">Reset</ButtonLink>
	</div>
</form>

{#if data.models.length === 0}
	<UxState
		state="empty"
		emptyTitle="No models match these filters"
		emptyHint="Loosen a filter or clear the search to see the full catalog."
	/>
{:else}
	<p class="muted">
		Showing <span class="num">{data.models.length}</span> of
		<span class="num">{data.total}</span> published models.
	</p>
	<TableWrap label="Model catalog">
		<table class="fr">
			<thead>
				<tr>
					<th>Model</th>
					<th>Developer</th>
					<th>Provider availability</th>
					<th>Input price</th>
					<th>Output price</th>
					<th>Context</th>
					<th>Capabilities</th>
					<th>Status</th>
					<th><span class="sr-only">Compare</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.models as m (m.slug)}
					{@const rollup = statusRollup(m)}
					{@const caps = trueCaps(m)}
					<tr>
						<td>
							<a href={'/models/' + encodeURIComponent(m.slug)}>{m.name}</a>
							{#if m.slug !== m.name}
								<br /><code class="slug">{m.slug}</code>
							{/if}
						</td>
						<td>{m.developer ?? '—'}</td>
						<td class="num"
							>{m.providers.length}
							{m.providers.length === 1 ? 'provider' : 'providers'}</td
						>
						<td class="num">{formatPricePer1M(m.price.inputPriceMicro, m.price.currency)}</td>
						<td class="num">{formatPricePer1M(m.price.outputPriceMicro, m.price.currency)}</td>
						<td class="num">{formatContext(m.context)}</td>
						<td>
							{#if caps.length === 0}
								<span class="muted">—</span>
							{:else}
								<span class="cap-badges">
									{#each caps as key (key)}
										<Badge tone="info">{CAPABILITY_LABELS[key]}</Badge>
									{/each}
								</span>
							{/if}
						</td>
						<td><Badge tone={rollup.tone}>{rollup.label}</Badge></td>
						<td>
							<label class="cmp">
								<input
									type="checkbox"
									checked={selected.includes(m.slug)}
									disabled={!selected.includes(m.slug) && selected.length >= MAX_COMPARE}
									onchange={(e) => toggle(m.slug, e.currentTarget.checked)}
								/>
								<span class="sr-only">Compare {m.name}</span>
							</label>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	{#if selected.length > 0}
		<div class="fr-actions">
			<ButtonLink variant="primary" href={compareHref}
				>Compare {selected.length} selected</ButtonLink
			>
		</div>
	{/if}
{/if}

<style>
	.filters {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-md);
		align-items: end;
		margin-bottom: var(--space-lg);
	}
	.caps {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		border: 0;
		padding: 0;
		margin: 0;
	}
	.caps legend {
		padding: 0;
	}
	.submit {
		grid-column: 1 / -1;
		display: flex;
		gap: var(--space-sm);
	}
	.slug {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
	.cap-badges {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.cmp {
		display: inline-flex;
		align-items: center;
	}
</style>
