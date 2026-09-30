<script lang="ts">
	import {
		Badge,
		EmptyState,
		Facts,
		Guide,
		PageHeader,
		Section,
		TableWrap,
		type Tone
	} from '$lib/ui';
	import { CAPABILITY_LABELS } from '$lib/capabilities';
	import { formatDate, formatDateTime } from '$lib/format';
	import { formatAvailability, formatContext, formatMs, formatPricePer1M } from '$lib/public-format';
	let { data } = $props();
	const meta = $derived(data.meta);
	// Overview rows: identity fields only — never connection details or anything
	// a credential could ride along in. Unknowns print as a dash (PRD §122).
	const facts = $derived(
		[
			{ term: 'Status', detail: data.provider.status === 'operational' ? 'Operational' : 'Degraded' },
			meta.description ? { term: 'About', detail: meta.description } : null,
			meta.type ? { term: 'Type', detail: meta.type } : null,
			meta.homepage ? { term: 'Homepage', detail: meta.homepage } : null,
			meta.documentationUrl ? { term: 'Documentation', detail: meta.documentationUrl } : null
		].filter((f): f is { term: string; detail: string } => f !== null)
	);
	const severityTone = (s: string): Tone =>
		s === 'critical' ? 'danger' : s === 'major' ? 'warning' : 'info';
	const statusTone = (s: string): Tone =>
		s === 'resolved' ? 'success' : s === 'monitoring' ? 'info' : 'warning';
	const statusWord = (s: string) =>
		({ investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' })[s] ?? s;
</script>
<PageHeader
	title={data.provider.name}
	lede="What this provider serves, how it prices, and how it is doing."
/>
<Section title="Overview">
	<Facts items={facts} />
</Section>
<Section title="Models" lede="Canonical models this provider currently serves.">
	{#if data.models.length === 0}
		<EmptyState title="No served models" hint="Nothing is published through this provider right now." />
	{:else}
		<TableWrap label="Models served by {data.provider.name}">
			<table class="fr">
				<thead>
					<tr>
						<th>Model</th>
						<th>Context</th>
						<th>Input / 1M</th>
						<th>Output / 1M</th>
					</tr>
				</thead>
				<tbody>
					{#each data.models as m (m.slug)}
						<tr>
							<td><a href={`/models/${encodeURIComponent(m.slug)}`}>{m.name}</a></td>
							<td class="num">{formatContext(m.context)}</td>
							<td class="num">{formatPricePer1M(m.price.inputPriceMicro, m.price.currency)}</td>
							<td class="num">{formatPricePer1M(m.price.outputPriceMicro, m.price.currency)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<p class="muted">Prices shown are what this provider bills for the model.</p>
	{/if}
</Section>
<Section title="Pricing" lede="Where this provider's prices differ from the model-wide price.">
	{#if data.pricingOverrides.length === 0}
		<p class="muted">
			This provider has no provider-specific prices — every model bills at the model-wide price.
		</p>
	{:else}
		<TableWrap label="Provider-specific prices">
			<table class="fr">
				<thead>
					<tr>
						<th>Model</th>
						<th>Provider input / 1M</th>
						<th>Provider output / 1M</th>
						<th>Model-wide input / 1M</th>
						<th>Model-wide output / 1M</th>
					</tr>
				</thead>
				<tbody>
					{#each data.pricingOverrides as m (m.slug)}
						<tr>
							<td><a href={`/models/${encodeURIComponent(m.slug)}`}>{m.name}</a></td>
							<td class="num"
								>{formatPricePer1M(m.providerPrice?.inputPriceMicro ?? null, m.providerPrice?.currency)}</td
							>
							<td class="num"
								>{formatPricePer1M(m.providerPrice?.outputPriceMicro ?? null, m.providerPrice?.currency)}</td
							>
							<td class="num muted"
								>{formatPricePer1M(m.widePrice.inputPriceMicro, m.widePrice.currency)}</td
							>
							<td class="num muted"
								>{formatPricePer1M(m.widePrice.outputPriceMicro, m.widePrice.currency)}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}
	<p class="muted">All models not listed here bill at the model-wide price.</p>
</Section>
<Section title="Capabilities" lede="Claimed true by at least one model this provider serves.">
	{#if data.capabilities.length === 0}
		<p class="muted">—</p>
	{:else}
		<span class="caps">
			{#each data.capabilities as key (key)}
				<Badge tone="neutral">{CAPABILITY_LABELS[key]}</Badge>
			{/each}
		</span>
	{/if}
</Section>
<Section title="Regions" lede="Connection regions this provider's mappings use.">
	{#if data.regions.length === 0}
		<p class="muted">—</p>
	{:else}
		<p>{data.regions.join(', ')}</p>
	{/if}
</Section>
<Section
	title="Availability"
	lede="Observed share of real requests that succeeded. A dash means no traffic yet."
>
	<p class="num">{formatAvailability(data.availability)}</p>
</Section>
<Section title="Performance" lede="Observed P50 and P95 latency from real requests.">
	<p class="num">{formatMs(data.performance.p50Ms)} / {formatMs(data.performance.p95Ms)}</p>
</Section>
<Section title="Recent incidents" lede="Filed against this provider or the major-providers component.">
	{#if data.incidents.length === 0}
		<EmptyState title="No incidents" hint="Nothing has been filed against this provider recently." />
	{:else}
		<TableWrap label="Recent incidents">
			<table class="fr">
				<thead>
					<tr>
						<th>Incident</th>
						<th>Severity</th>
						<th>Status</th>
						<th>Started</th>
						<th>Resolved</th>
						<th>Latest update</th>
					</tr>
				</thead>
				<tbody>
					{#each data.incidents as inc (inc.id)}
						<tr>
							<td><a href={`/status/incidents/${encodeURIComponent(inc.id)}`}>{inc.title}</a></td>
							<td><Badge tone={severityTone(inc.severity)}>{inc.severity}</Badge></td>
							<td><Badge tone={statusTone(inc.status)}>{statusWord(inc.status)}</Badge></td>
							<td class="num">{formatDateTime(new Date(inc.startedAt))}</td>
							<td class="num"
								>{inc.resolvedAt ? formatDateTime(new Date(inc.resolvedAt)) : '—'}</td
							>
							<td>
								{#if inc.latestUpdate}
									<span class="muted"
										>{formatDate(new Date(inc.latestUpdate.createdAt))} — {inc.latestUpdate.message}</span
									>
								{:else}
									<span class="muted">—</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}
</Section>
<Guide id="provider" />
<style>
	.caps {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
</style>
