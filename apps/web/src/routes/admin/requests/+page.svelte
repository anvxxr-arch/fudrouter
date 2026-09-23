<script lang="ts">
	import {formatCost, formatTokens, formatDateTime} from '$lib/format';
	import { Badge, Button, EmptyState, Field, Guide, PageHeader, Select, TableWrap } from '$lib/ui';

	let { data } = $props();
</script>

<PageHeader title="API call history" lede="Every call across all users, newest first." />

<form class="filters" method="GET">
	<div class="pick">
		<Field label="Status">
			<Select name="status">
				<option value="" selected={!data.status}>All</option>
				<option value="success" selected={data.status === 'success'}>success</option>
				<option value="upstream_error" selected={data.status === 'upstream_error'}
					>upstream_error</option
				>
				<option value="error" selected={data.status === 'error'}>error</option>
			</Select>
		</Field>
	</div>
	<Button type="submit">Filter</Button>
</form>

<p class="muted">Showing the latest {data.rows.length} calls (max 200).</p>

<Guide id="admin-requests" />

<TableWrap label="Call history">
<table class="fr">
	
		<thead>
			<tr>
				<th>When</th><th>User</th><th>Key</th><th>Model</th><th>Provider</th>
				<th>In</th><th>Out</th><th>Cost</th><th>Latency</th><th>Status</th>
			</tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.email}</td>
					<td>{r.keyName ?? '—'}</td>
					<td>{r.modelSlug ?? '—'}</td>
					<td>{r.providerName ?? '—'}</td>
					<td class="num">{formatTokens(r.tokensIn)}</td>
					<td class="num">{formatTokens(r.tokensOut)}</td>
					<td class="num">{formatCost(r.cost, r.currency)}</td>
					<td class="num">{(r.latencyMs ?? 0).toLocaleString()} ms</td>
					<td>
						<Badge tone={r.status === 'success' ? 'success' : 'danger'}>
							{r.status}{r.error ? `: ${r.error}` : ''}
						</Badge>
					</td>
				</tr>
			{:else}
				<tr><td colspan="10"><EmptyState title="No calls recorded" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap>

<style>
	.filters {
		display: flex;
		gap: var(--fr-space-md);
		align-items: flex-end;
		margin: var(--fr-space-md) 0;
	}
	.pick {
		width: 12rem;
	}
</style>
