<script lang="ts">
	import { Badge, EmptyState, Guide, PageHeader, Section, TableWrap } from '$lib/ui';
	import { CAPABILITY_LABELS } from '$lib/capabilities';
	import { formatAvailability, formatMs } from '$lib/public-format';
	let { data } = $props();
	// Detail links use the provider slug when the row carries one, else its name;
	// /providers/[slug] matches either, case-insensitively.
	const hrefFor = (row: { slug: string | null; name: string }) =>
		`/providers/${encodeURIComponent(row.slug ?? row.name)}`;
</script>
<PageHeader
	title="Providers"
	lede="The upstream AI providers this network routes to, and how each one is doing."
/>
<Section title="Directory" lede="Every provider with at least one served model.">
	{#if data.providers.length === 0}
		<EmptyState
			title="No providers yet"
			hint="Providers appear here once they serve at least one published model."
		/>
	{:else}
		<TableWrap label="Provider directory">
			<table class="fr">
				<thead>
					<tr>
						<th>Provider</th>
						<th>Status</th>
						<th>Models</th>
						<th>Capabilities</th>
						<th>Regions</th>
						<th>Latency (P50 / P95)</th>
						<th>Availability</th>
					</tr>
				</thead>
				<tbody>
					{#each data.providers as row (row.name)}
						<tr>
							<td><a href={hrefFor(row)}>{row.name}</a></td>
							<td>
								{#if row.status === 'operational'}
									<Badge tone="success">Operational</Badge>
								{:else}
									<Badge tone="warning">Degraded</Badge>
								{/if}
							</td>
							<td class="num">{row.modelCount}</td>
							<td>
								{#if row.capabilities.length === 0}
									<span class="muted">—</span>
								{:else}
									<span class="caps">
										{#each row.capabilities as key (key)}
											<Badge tone="neutral">{CAPABILITY_LABELS[key]}</Badge>
										{/each}
									</span>
								{/if}
							</td>
							<td>
								{#if row.regions.length === 0}
									<span class="muted">—</span>
								{:else}
									{row.regions.join(', ')}
								{/if}
							</td>
							<td class="num"
								>{#if row.p50Ms === null && row.p95Ms === null}<span class="muted">—</span>{:else}{formatMs(
										row.p50Ms
									)} / {formatMs(row.p95Ms)}{/if}</td
							>
							<td class="num">{formatAvailability(row.availability)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<p class="muted">
			Latency and availability are observed from real requests; a dash means no traffic yet.
		</p>
	{/if}
</Section>
<Guide id="providers" />
<style>
	.caps {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
</style>
