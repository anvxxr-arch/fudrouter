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
		StatCard,
		TableWrap,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatCost, formatDateTime, formatTokens } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const m = $derived(data.model);
	const fmt = (micro: string | null) => (micro === null ? null : formatCost(BigInt(micro), data.model.currency));
</script>
<PageHeader
	title="Model · {m.slug}"
	lede="One canonical model: fields, its provider mappings, versioned prices and observed request traffic."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}
<Guide id="admin-model-detail" />
<Card>
	<h2 class="first">Request traffic</h2>
	<div class="stats">
		<StatCard label="Requests" value={formatTokens(data.usage.totals.requests)} />
		<StatCard
			label="Success"
			value={formatTokens(data.usage.totals.ok)}
			tone={data.usage.totals.requests > 0 && data.usage.totals.ok === data.usage.totals.requests
				? 'success'
				: 'neutral'}
		/>
		<StatCard label="Tokens in" value={formatTokens(data.usage.totals.tokensIn)} />
		<StatCard label="Tokens out" value={formatTokens(data.usage.totals.tokensOut)} />
		<StatCard label="Cost (all time)" value={formatCost(BigInt(data.usage.totals.cost), data.usage.currency)} />
		<StatCard label="Last 24h" value={formatTokens(data.usage.day.requests)} />
	</div>
	{#if data.usage.perDay.length > 0}
		<TableWrap label="Requests per day (14 days)">
			<table class="fr">
				<thead>
					<tr><th>Day</th><th>Requests</th><th>Success</th><th>Cost</th></tr>
				</thead>
				<tbody>
					{#each data.usage.perDay as d (d.day)}
						<tr>
							<td>{d.day}</td>
							<td class="num">{formatTokens(d.requests)}</td>
							<td class="num">{formatTokens(d.ok)}</td>
							<td class="num">{formatCost(BigInt(d.cost), data.usage.currency)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{:else}
		<EmptyState title="No requests in the last 14 days" />
	{/if}
</Card>
<Card>
	<h2 class="first">Canonical fields</h2>
	<form method="POST" action="?/update" use:enhance={track}>
		<input type="hidden" name="id" value={m.id} />
		<div class="fr-grid">
			<Field label="Display name"><Input name="name" value={m.name} required /></Field>
			<Field label="Slug"><Input name="slug" value={m.slug} required /></Field>
			<Field label="Family"><Input name="family" value={m.family ?? ''} /></Field>
			<Field label="Developer"><Input name="developer" value={m.developer ?? ''} /></Field>
			<Field label="Context"><Input name="context" type="number" value={m.context ?? ''} /></Field>
			<Field label="Max output"><Input name="maxOutput" type="number" value={m.maxOutput ?? ''} /></Field>
			<Field label="Status">
				<Select name="status">
					{#if !(data.statuses as readonly string[]).includes(m.status)}
						<option value={m.status} selected>{m.status} (stored)</option>
					{/if}
					{#each data.statuses as s (s)}<option value={s} selected={s === m.status}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Modality (JSON)"><Input name="modality" value={JSON.stringify(m.modality)} /></Field>
			<Field label="Capabilities (JSON flags)">
				<Input name="capabilities" value={JSON.stringify(m.capabilities)} />
			</Field>
			<Field label="Description">
				<Textarea name="description" rows="2" value={m.description ?? ''}></Textarea>
			</Field>
		</div>
		<p class="muted">
			Legacy price mirror (updated via versioned pricing only): {m.inputUsd} / {m.outputUsd} USD per
			1M tokens · created {formatDateTime(new Date(m.createdAt))}
		</p>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save fields</Button>
		</div>
	</form>
</Card>
<Card>
	<h2 class="first">Provider mappings</h2>
	<p class="muted">The provider_model rows that can serve this model. Overrides beat the canonical values.</p>
	<TableWrap label="Provider mappings">
		<table class="fr">
			<thead>
				<tr>
					<th>Provider</th><th>Connection</th><th>Upstream id</th><th>Context</th><th>Status</th
					><th>Enabled</th><th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.mappings as row (row.id)}
					<tr>
						<td>{row.providerName}</td>
						<td>{row.connectionName ?? 'any'}</td>
						<td><code>{row.providerModelId}</code></td>
						<td class="num">{row.context ?? '—'}</td>
						<td><Badge tone={row.status === 'available' ? 'success' : 'neutral'}>{row.status}</Badge></td>
						<td>{row.enabled ? 'enabled' : 'disabled'}</td>
						<td class="fr-actions">
							<form method="POST" action="?/mapping" use:enhance={track} class="fr-inline">
								<input type="hidden" name="id" value={row.id} />
								<Field label="Status">
									<Select name="status">
										{#each data.mappingStatuses as s (s)}
											<option value={s} selected={s === row.status}>{s}</option>
										{/each}
									</Select>
								</Field>
								<label class="muted">
									<input type="checkbox" name="enabled" checked={row.enabled} /> enabled
								</label>
								<Button type="submit" {pending} aria-label="Save mapping {row.providerModelId}">
									Save
								</Button>
							</form>
						</td>
					</tr>
				{:else}
					<tr><td colspan="7"><EmptyState title="No provider mappings" hint="Add one on the mappings page." /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="first">Pricing history</h2>
	<p class="muted">
		Versioned rows, newest first per scope — history is never edited. A NULL cached or reasoning
		price falls back to input / output.
	</p>
	<TableWrap label="Pricing history">
		<table class="fr">
			<thead>
				<tr>
					<th>Scope</th><th>Version</th><th>Input</th><th>Cached input</th><th>Output</th><th
						>Reasoning</th
					><th>Effective from</th><th>Effective until</th><th>State</th>
				</tr>
			</thead>
			<tbody>
				{#each data.pricing as r (r.id)}
					<tr>
						<td><code>{r.scope}</code></td>
						<td class="num">v{r.version}</td>
						<td class="num">{fmt(r.inputPriceMicro)}</td>
						<td class="num">{r.cachedInputPriceMicro === null ? 'falls back to input' : fmt(r.cachedInputPriceMicro)}</td>
						<td class="num">{fmt(r.outputPriceMicro)}</td>
						<td class="num">{r.reasoningPriceMicro === null ? 'falls back to output' : fmt(r.reasoningPriceMicro)}</td>
						<td class="num">{formatDateTime(new Date(r.effectiveFrom))}</td>
						<td class="num">{r.effectiveUntil ? formatDateTime(new Date(r.effectiveUntil)) : '—'}</td>
						<td>
							{#if r.current}<Badge tone="success">current</Badge>{:else}<Badge tone="neutral"
									>closed</Badge
								>{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="9"><EmptyState title="No pricing rules" hint="Creating a model writes v1." /></td></tr>
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
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-bottom: var(--space-md);
	}
</style>
