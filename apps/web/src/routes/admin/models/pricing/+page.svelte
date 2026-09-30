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
		Input,
		PageHeader,
		Select,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatCost, formatDateTime } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	// Which model the proposal form targets; its mappings fill the scope select.
	let modelId = $state(data.modelFilter || data.models[0]?.id || '');
	const mappings = $derived(
		data.mappings.filter((m: { modelId: string }) => m.modelId === modelId)
	);
	function micro(value: string | null, currency: string): string {
		return value === null ? '' : formatCost(BigInt(value), currency);
	}
</script>
<PageHeader
	title="Model pricing"
	lede="Versioned prices per model. A price change is a new version row — history is never edited, so past bills stay reproducible."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}
<Guide id="admin-model-pricing" />
<Card>
	<h2 class="first">Propose a new price</h2>
	<p class="muted">
		Preview computes the exact version row <code>?/apply</code> would insert and diffs it against the
		current row. Nothing is written until you review the diff and tick <strong>approved</strong>.
	</p>
	<form method="POST" action="?/preview" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Model">
				<Select name="modelId" bind:value={modelId}>
					{#each data.models as m (m.id)}<option value={m.id}>{m.slug}</option>{/each}
				</Select>
			</Field>
			<Field label="Scope" hint="Model-wide, or one provider mapping">
				<Select name="providerModelId">
					<option value="">model-wide</option>
					{#each mappings as pm (pm.id)}
						<option value={pm.id}>{pm.upstream}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Currency"><Input name="currency" value="USD" maxlength="3" /></Field>
			<Field label="Input USD / 1M"><Input name="inputPrice" type="number" step="0.0001" placeholder="2.00" /></Field>
			<Field label="Cached input USD / 1M" hint="Empty = falls back to input">
				<Input name="cachedInputPrice" type="number" step="0.0001" placeholder="0.50" />
			</Field>
			<Field label="Output USD / 1M"><Input name="outputPrice" type="number" step="0.0001" placeholder="6.00" /></Field>
			<Field label="Reasoning USD / 1M" hint="Empty = falls back to output">
				<Input name="reasoningPrice" type="number" step="0.0001" />
			</Field>
			<Field label="Effective from" hint="Empty = now"><Input name="effectiveFrom" type="date" /></Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Preview</Button>
		</div>
	</form>
</Card>
{#if form?.preview}
	<Card>
		<h2 class="first">Preview · {form.preview.modelSlug} · {form.preview.scope}</h2>
		<p class="muted">
			Applying inserts <strong>v{form.preview.version}</strong>
			{#if form.preview.old}
				and closes v{form.preview.old.version}
				(live since {formatDateTime(new Date(form.preview.old.effectiveFrom))}){:else}
			— there is no current row, so this is v1{/if}. Effective from {formatDateTime(
				new Date(form.preview.effectiveFrom)
			)}.
		</p>
		<TableWrap label="Price diff">
			<table class="fr">
				<thead>
					<tr><th>Field</th><th>Current</th><th>New (v{form.preview.version})</th><th>Change</th></tr>
				</thead>
				<tbody>
					{#each form.preview.diff as d (d.key)}
						<tr>
							<td>{d.label}</td>
							<td class="num">
								{#if d.before === null}<span class="muted">NULL</span>{:else}{formatCost(
										BigInt(d.before),
										form.preview.currency
									)}{/if}
							</td>
							<td class="num">
								{#if d.after === null}<span class="muted">NULL</span>{:else}{formatCost(
										BigInt(d.after),
										form.preview.currency
									)}{/if}
							</td>
							<td>
								{#if d.changed}<Badge tone="warning">changed</Badge>{:else}<Badge tone="neutral"
										>unchanged</Badge
									>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<p class="muted">
			NULL cached input / reasoning mean “falls back to input / output” — a change between a value
			and NULL is a real change.
		</p>
		<form method="POST" action="?/apply" use:enhance={track}>
			<input type="hidden" name="modelId" value={form.preview.modelId} />
			<input type="hidden" name="providerModelId" value={form.preview.providerModelId ?? ''} />
			<input type="hidden" name="currency" value={form.preview.currency} />
			<input
				type="hidden"
				name="effectiveFrom"
				value={form.preview.effectiveFrom}
			/>
			{#each form.preview.diff as d (d.key)}
				<input type="hidden" name={d.key} value={d.afterUsd ?? ''} />
			{/each}
			<label class="approve">
				<input type="checkbox" name="approved" /> approved — insert v{form.preview.version} and close
				the current row
			</label>
			<div class="submit">
				<Button type="submit" {pending} variant="primary">Apply new version</Button>
			</div>
		</form>
	</Card>
{/if}
<Card>
	<h2 class="first">Version history</h2>
	<p class="muted">
		Newest first per model and scope. A closed row keeps its prices byte-identical forever; NULL
		cached / reasoning prices fall back to input / output.
	</p>
	<form method="GET" class="filters">
		<Field label="Model">
			<Select name="model">
				<option value="">All models</option>
				{#each data.models as m (m.id)}
					<option value={m.id} selected={m.id === data.modelFilter}>{m.slug}</option>
				{/each}
			</Select>
		</Field>
		<div class="submit"><Button type="submit">Filter</Button></div>
	</form>
	<TableWrap label="Pricing versions">
		<table class="fr">
			<thead>
				<tr>
					<th>Model</th><th>Scope</th><th>Version</th><th>Input</th><th>Cached input</th><th
						>Output</th
					><th>Reasoning</th><th>Effective from</th><th>Effective until</th><th>State</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rules as r (r.id)}
					<tr>
						<td><code>{r.modelSlug}</code></td>
						<td><code>{r.scope}</code></td>
						<td class="num">v{r.version}</td>
						<td class="num">{micro(r.inputPriceMicro, r.currency)}</td>
						<td class="num"
							>{r.cachedInputPriceMicro === null
								? 'falls back to input'
								: micro(r.cachedInputPriceMicro, r.currency)}</td
						>
						<td class="num">{micro(r.outputPriceMicro, r.currency)}</td>
						<td class="num"
							>{r.reasoningPriceMicro === null
								? 'falls back to output'
								: micro(r.reasoningPriceMicro, r.currency)}</td
						>
						<td class="num">{formatDateTime(new Date(r.effectiveFrom))}</td>
						<td class="num"
							>{r.effectiveUntil ? formatDateTime(new Date(r.effectiveUntil)) : '—'}</td
						>
						<td>
							{#if r.current}<Badge tone="success">current</Badge>{:else}<Badge tone="neutral"
									>closed</Badge
								>{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="10"><EmptyState title="No pricing rules" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
	.filters {
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		align-items: end;
	}
	.approve {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}
</style>
