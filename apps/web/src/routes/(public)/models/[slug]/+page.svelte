<script lang="ts">
	import { Badge, CodeBlock, Facts, Guide, PageHeader, Section, TableWrap } from '$lib/ui';
	import { CAPABILITY_LABELS, type CapabilityKey } from '$lib/capabilities';
	import {
		formatAvailability,
		formatContext,
		formatMs,
		formatPricePer1M
	} from '$lib/public-format';
	import type { CatalogModel, PriceMicro } from '$lib/server/public-catalog';

	let { data } = $props();
	const m = $derived(data.model as CatalogModel);

	/** Per-1M input price shown per provider: its own rule when set, else the model-wide one. */
	const inputOf = (p: PriceMicro) => formatPricePer1M(p.inputPriceMicro, p.currency);
	const outputOf = (p: PriceMicro) => formatPricePer1M(p.outputPriceMicro, p.currency);

	function capWord(value: boolean | null): string {
		return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
	}
	function capTone(value: boolean | null): 'success' | 'danger' | 'neutral' {
		return value === true ? 'success' : value === false ? 'danger' : 'neutral';
	}
	function statusTone(status: string): 'success' | 'warning' | 'danger' {
		if (status === 'available') return 'success';
		if (status === 'degraded') return 'warning';
		return 'danger';
	}

	// Providers whose specific pricing rule differs from the model-wide rule.
	const overrides = $derived(m.providers.filter((p) => p.price !== null));
	// Modality is free-form metadata: its keys are the input/output media, and
	// an unenriched model renders as an em dash rather than an invented answer.
	const modalityKeys = $derived(Object.keys(m.modality));
	const hasReasoning = $derived(m.price.reasoningPriceMicro !== null);
	// Facts keys on its term, so a provider with two connections needs numbered
	// terms or the keyed each sees a duplicate key.
	const upstreamFacts = $derived.by(() => {
		const seen = new Map<string, number>();
		return data.identifiers.providerForms.map((f) => {
			const n = (seen.get(f.providerName) ?? 0) + 1;
			seen.set(f.providerName, n);
			return {
				term: n === 1 ? f.providerName : `${f.providerName} (${n})`,
				detail: f.id
			};
		});
	});
</script>

<PageHeader title={m.name} lede={m.description ?? undefined} />
<Guide id="models-detail" />

<Section title="Overview" lede="What this model is.">
	<Facts
		items={[
			{ term: 'Slug', detail: m.slug },
			...(m.slug !== m.name ? [{ term: 'Name', detail: m.name }] : []),
			{ term: 'Developer', detail: m.developer ?? 'Unknown' },
			...(m.family ? [{ term: 'Family', detail: m.family }] : []),
			{ term: 'Context', detail: formatContext(m.context) },
			{ term: 'Max output', detail: formatContext(m.maxOutput) },
			{ term: 'Modality', detail: modalityKeys.length > 0 ? modalityKeys.join(', ') : '—' }
		]}
	/>
</Section>

<Section title="Capabilities" lede="Yes / No / Unknown. A missing capability is unknown, never a claim of “No”.">
	<TableWrap label="Capabilities">
		<table class="fr">
			<thead>
				<tr><th>Capability</th><th>Support</th></tr>
			</thead>
			<tbody>
				{#each data.capabilities as row (row.key)}
					<tr>
						<td>{CAPABILITY_LABELS[row.key as CapabilityKey]}</td>
						<td>
							<Badge tone={capTone(row.value)}>{capWord(row.value)}</Badge>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Section>

<Section title="Pricing" lede="Normalized per 1M tokens.">
	<TableWrap label="Model-wide pricing">
		<table class="fr">
			<thead>
				<tr>
					<th>Input</th>
					<th>Cached input</th>
					<th>Output</th>
					{#if hasReasoning}<th>Reasoning</th>{/if}
				</tr>
			</thead>
			<tbody>
				<tr>
					<td class="num">{inputOf(m.price)}</td>
					<td class="num"
						>{formatPricePer1M(m.price.cachedInputPriceMicro, m.price.currency)}</td
					>
					<td class="num">{outputOf(m.price)}</td>
					{#if hasReasoning}
						<td class="num"
							>{formatPricePer1M(m.price.reasoningPriceMicro, m.price.currency)}</td
						>
					{/if}
				</tr>
			</tbody>
		</table>
	</TableWrap>
	{#if overrides.length > 0}
		<h3 class="sub">Provider-specific prices</h3>
		<p class="muted">These providers bill differently from the model-wide price:</p>
		<TableWrap label="Provider-specific prices">
			<table class="fr">
				<thead>
					<tr><th>Provider</th><th>Input</th><th>Output</th></tr>
				</thead>
				<tbody>
					{#each overrides as p (p.providerModelId)}
						<tr>
							<td>{p.providerName}</td>
							<td class="num">{inputOf(p.price!)}</td>
							<td class="num">{outputOf(p.price!)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}
	<p class="muted">
		{#if overrides.length > 0}
			All other providers bill at the model-wide price above.
		{:else}
			All providers bill at the model-wide price above.
		{/if}
	</p>
</Section>

<Section title="Provider Availability" lede="Every live route that serves this model.">
	<TableWrap label="Provider availability">
		<table class="fr">
			<thead>
				<tr>
					<th>Provider</th>
					<th>Connection</th>
					<th>Status</th>
					<th>Input price</th>
					<th>Output price</th>
					<th>P50</th>
					<th>P95</th>
					<th>Availability</th>
				</tr>
			</thead>
			<tbody>
				{#each m.providers as p (p.providerModelId)}
					<tr>
						<td>{p.providerName}</td>
						<td>{p.connectionName ?? '—'}</td>
						<td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
						<td class="num">{inputOf(p.price ?? m.price)}</td>
						<td class="num">{outputOf(p.price ?? m.price)}</td>
						<td class="num">{formatMs(p.p50Ms)}</td>
						<td class="num">{formatMs(p.p95Ms)}</td>
						<td class="num">{formatAvailability(p.availability)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Section>

<Section title="API Usage" lede="Call this model with your key.">
	<CodeBlock label="Chat completion" code={data.curl} />
</Section>

<Section title="Model Identifiers" lede="What to send as `model`, and what each provider calls it upstream.">
	<Facts
		items={[
			{ term: 'Canonical', detail: data.identifiers.canonical },
			{ term: 'FUDRouter', detail: data.identifiers.fudrouter },
			...upstreamFacts
		]}
	/>
</Section>

<style>
	.sub {
		margin: var(--space-md) 0 var(--space-xs);
		font-size: var(--text-base);
		color: var(--color-text);
	}
</style>
