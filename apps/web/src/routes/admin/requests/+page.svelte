<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import { Badge, Button, EmptyState, Field, Guide, Input, PageHeader, Select, TableWrap } from '$lib/ui';

	let { data } = $props();
	const f = $derived(data.filters);
</script>

<PageHeader title="API call history" lede="Every call across all users, newest first." />
<Guide id="admin-requests" />
<form class="filters" method="GET">
	<div class="pick">
		<Field label="Status">
			<Select name="status" value={f.status}>
				<option value="">All</option>
				{#each data.statuses as s (s)}
					<option value={s}>{s}</option>
				{/each}
			</Select>
		</Field>
	</div>
	<div class="pick">
		<Field label="Error code">
			<Input name="error_code" value={f.errorCode} placeholder="e.g. MODEL_NOT_FOUND" />
		</Field>
	</div>
	<div class="pick">
		<Field label="Model">
			<Input name="model" value={f.model} placeholder="requested or resolved slug" />
		</Field>
	</div>
	<div class="pick">
		<Field label="Provider">
			<Select name="provider" value={f.provider}>
				<option value="">All</option>
				{#each data.providers as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</Select>
		</Field>
	</div>
	<div class="pick">
		<Field label="From"><Input name="from" type="date" value={f.from} /></Field>
	</div>
	<div class="pick">
		<Field label="To"><Input name="to" type="date" value={f.to} /></Field>
	</div>
	<Button type="submit">Filter</Button>
</form>
<p class="muted">Showing the latest {data.rows.length} calls (max 200).</p>
<TableWrap label="Call history">
	<table class="fr">
		<thead>
			<tr>
				<th>When</th><th>User</th><th>Requested model</th><th>Resolved</th><th>Provider</th>
				<th>Connection</th><th>Strategy</th><th>Attempts</th><th>Fallback</th><th>TTFT</th>
				<th>Latency</th><th>Status</th><th>Error code</th><th>HTTP</th><th>Tokens</th><th>Cost</th>
			</tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.id)}
				<tr>
					<td class="num"
						><a href={resolve(`/admin/requests/${r.id}`)}>{formatDateTime(r.createdAt)}</a></td
					>
					<td>{r.email}{r.keyName ? ` <span class="muted">(${r.keyName})</span>` : ''}</td>
					<td><code>{r.requestedModel ?? '—'}</code></td>
					<td><code>{r.modelSlug ?? '—'}</code></td>
					<td>{r.providerName ?? '—'}</td>
					<td>{r.connectionName ?? '—'}</td>
					<td>{r.strategy ?? '—'}</td>
					<td class="num">{r.attempts}</td>
					<td>{r.fallbackUsed ? 'yes' : 'no'}</td>
					<td class="num">{r.ttftMs != null ? `${r.ttftMs.toLocaleString()} ms` : '—'}</td>
					<td class="num">{r.latencyMs.toLocaleString()} ms</td>
					<td>
						<Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
					</td>
					<td><code>{r.errorCode ?? '—'}</code></td>
					<td class="num">{r.httpStatus ?? '—'}</td>
					<td class="num">{formatTokens(r.tokensIn)} in / {formatTokens(r.tokensOut)} out</td>
					<td class="num">{formatCost(r.cost, r.currency)}</td>
				</tr>
			{:else}
				<tr><td colspan="16"><EmptyState title="No calls recorded" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
{#if data.rows.length > 0}
	<p class="muted">
		Pages: {#if f.status || f.errorCode || f.model || f.provider || f.from || f.to}
			<a href={resolve('/admin/requests')}>clear filters</a>
		{:else}
			<span>newest first</span>
		{/if}
	</p>
{/if}

<style>
	.filters {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		margin: var(--space-md) 0;
		flex-wrap: wrap;
	}
	.pick {
		width: 12rem;
	}
</style>
