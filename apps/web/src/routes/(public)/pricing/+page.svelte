<script lang="ts">
	import { ButtonLink, PageHeader, Section, TableWrap, UxState } from '$lib/ui';
	import { formatContext, formatPricePer1M } from '$lib/public-format';
	let { data } = $props();

	const detailHref = (slug: string) => '/models/' + encodeURIComponent(slug);
</script>

<PageHeader title="Pricing" lede="Pay per token — no seat fees. One API key, every model." />

<p class="muted">
	All prices are normalized per 1M tokens. Input, cached input and output each bill at their own
	rate.
</p>

{#if data.groups.length === 0}
	<UxState state="empty" emptyTitle="No models published yet" emptyHint="Prices appear as soon as a model is published." />
{:else}
	{#each data.groups as group (group.developer)}
		<Section title={group.developer} lede="{group.models.length} {group.models.length === 1 ? 'model' : 'models'}">
			<TableWrap label={group.developer + ' prices'}>
				<table class="fr">
					<thead>
						<tr>
							<th>Model</th>
							<th>Input</th>
							<th>Cached input</th>
							<th>Output</th>
							<th>Context</th>
							{#if data.hasReasoning}<th>Reasoning</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each group.models as row (row.slug)}
							<tr>
								<td>
									<a href={detailHref(row.slug)}>{row.name}</a>
									{#if row.slug !== row.name}
										<br /><code class="slug">{row.slug}</code>
									{/if}
								</td>
								{#if row.variesByProvider}
									<!-- A provider-specific rule means the model-wide numbers would be
									     wrong for that route — no single number is shown. The note spans
									     every price column so it is stated once, not once per column. -->
									<td class="num" colspan={data.hasReasoning ? 4 : 3}>
										<span class="muted"
											><a href={detailHref(row.slug)}>varies by provider — see model</a></span
										>
									</td>
								{:else}
									<td class="num"
										>{formatPricePer1M(row.price.inputPriceMicro, row.price.currency)}</td
									>
									<td class="num"
										>{formatPricePer1M(row.price.cachedInputPriceMicro, row.price.currency)}</td
									>
									<td class="num"
										>{formatPricePer1M(row.price.outputPriceMicro, row.price.currency)}</td
									>
									{#if data.hasReasoning}
										<td class="num"
											>{formatPricePer1M(row.price.reasoningPriceMicro, row.price.currency)}</td
										>
									{/if}
								{/if}
								<td class="num">{formatContext(row.context)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>
	{/each}
{/if}

<Section title="Coding plan" lede="Included in a subscription instead of billed per token.">
	<p class="muted">
		Coding-plan models would be covered by a subscription. That program is not live yet.
	</p>
</Section>

<div class="cta">
	<ButtonLink variant="primary" href="/signup">Get started</ButtonLink>
	<span class="muted">Then mint a key and point a client at the API.</span>
</div>

<style>
	.slug {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
</style>
