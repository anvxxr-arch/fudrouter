<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		PageHeader,
		Select,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatCost, formatTokens } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const diff = $derived(form?.fetched ?? null);
	function price(micro: string | null): string {
		return micro === null ? 'not reported' : formatCost(BigInt(micro), 'USD');
	}
</script>
<PageHeader
	title="Catalog sync"
	lede="Diff the upstream catalog against local mappings, then apply what you select. A fetch never deletes a canonical model on its own."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}
<Guide id="admin-model-sync" />
<Card>
	<h2 class="first">Fetch upstream catalog</h2>
	<form method="POST" action="?/fetch" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Provider">
				<Select name="providerId" required>
					{#each data.providers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</Select>
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Fetch & diff</Button>
		</div>
	</form>
</Card>
{#if diff}
	<Card>
		<h2 class="first">Diff · {diff.providerName}</h2>
		<p class="muted">
			{formatTokens(diff.upstreamCount)} upstream models vs {formatTokens(diff.checkedCount)} local
			mappings — {diff.additions.length} additions, {diff.changes.length} changes, {diff.removals.length}
			removal suggestions.
		</p>
		<form method="POST" action="?/apply" use:enhance={track}>
			<input type="hidden" name="providerId" value={diff.providerId} />
			<h3>Additions</h3>
			<p class="muted">
				Upstream slugs with no local mapping. Tick to create: the canonical model (slug, context and
				prices from upstream), one provider mapping (upstream name as reported) and pricing v1.
			</p>
			{#if diff.additions.length > 0}
				<TableWrap label="Additions">
					<table class="fr">
						<thead>
							<tr>
								<th><span class="sr-only">Add</span></th><th>Slug</th><th>Name</th><th
									>Context</th
								><th>In / 1M</th><th>Out / 1M</th>
							</tr>
						</thead>
						<tbody>
							{#each diff.additions as a (a.json)}
								<tr>
									<td>
										<input
											type="checkbox"
											name="add"
											value={a.json}
											aria-label="Add model {a.slug}"
										/>
									</td>
									<td><code>{a.slug}</code></td>
									<td>{a.name}</td>
									<td class="num">{a.context ?? '—'}</td>
									<td class="num">{price(a.inputPriceMicro)}</td>
									<td class="num">{price(a.outputPriceMicro)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</TableWrap>
			{:else}
				<EmptyState title="No additions" hint="Every upstream slug already has a local mapping." />
			{/if}
			<h3>Changes</h3>
			<p class="muted">
				Same slug, different fields. Ticking one updates the mapping's upstream name and context
				override. Price drift is shown for information — a price change is a versioned update on the
				pricing page, never edited in place here.
			</p>
			{#if diff.changes.length > 0}
				<TableWrap label="Changes">
					<table class="fr">
						<thead>
							<tr>
								<th><span class="sr-only">Update</span></th><th>Slug</th><th>Different</th><th
									>Upstream id</th
								><th>Context (now → new)</th><th>In / 1M (now → upstream)</th><th
									>Out / 1M (now → upstream)</th
								>
							</tr>
						</thead>
						<tbody>
							{#each diff.changes as c (c.json)}
								<tr>
									<td>
										<input
											type="checkbox"
											name="change"
											value={c.json}
											aria-label="Update mapping for {c.slug}"
										/>
									</td>
									<td><code>{c.slug}</code></td>
									<td>{c.reasons.join(', ')}</td>
									<td><code>{c.providerModelId}</code></td>
									<td class="num">{c.beforeContext ?? '—'} → {c.contextOverride ?? '—'}</td>
									<td class="num">{price(c.beforeInput)} → {price(c.afterInput)}</td>
									<td class="num">{price(c.beforeOutput)} → {price(c.afterOutput)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</TableWrap>
			{:else}
				<EmptyState title="No changes" hint="Local mappings match what the upstream reports." />
			{/if}
			<div class="submit">
				<Button type="submit" {pending} variant="primary">Apply ticked rows</Button>
			</div>
		</form>
		<h3>Removal suggestions</h3>
		<p class="muted">
			Local mappings this fetch did not report. <strong>Suggestions only</strong> — there is no delete
			here on purpose: one missed slug in one fetch must never erase a canonical model or its pricing
			history.
		</p>
		{#if diff.removals.length > 0}
			<TableWrap label="Removal suggestions">
				<table class="fr">
					<thead>
						<tr><th>Slug</th><th>Upstream id</th><th>What you can do</th></tr>
					</thead>
					<tbody>
						{#each diff.removals as r (r.id)}
							<tr>
								<td><code>{r.slug}</code></td>
								<td><code>{r.providerModelId}</code></td>
								<td class="muted"
									>Disable it on the model detail or mappings page if the provider truly dropped it</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No removal suggestions" hint="Every local mapping was reported upstream." />
		{/if}
	</Card>
{/if}
<style>
	h2.first {
		margin-top: 0;
	}
	h3 {
		margin-bottom: var(--space-xs);
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
</style>
