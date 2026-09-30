<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { Button, EmptyState, Field, Guide, PageHeader, Select, TableWrap } from '$lib/ui';
	let { data } = $props();
	function meta(value: unknown): string {
		const s = JSON.stringify(value, null, 2);
		return s && s !== '{}' ? (s.length > 400 ? s.slice(0, 400) + '…' : s) : '—';
	}
</script>

<PageHeader title="System events" lede="Operational events, newest first, filterable by type." />
<Guide id="admin-system-events" />
<form class="filters" method="GET">
	<div class="pick">
		<Field label="Type">
			<Select name="type">
				<option value="" selected={!data.type}>All</option>
				{#each data.types as t (t)}
					<option value={t} selected={data.type === t}>{t}</option>
				{/each}
			</Select>
		</Field>
	</div>
	<Button type="submit">Filter</Button>
</form>
<p class="muted">Showing the latest {data.rows.length} events (max 200).</p>
<TableWrap label="System events">
	<table class="fr">
		<thead>
			<tr><th>When</th><th>Type</th><th>Resource</th><th>Workspace</th><th>Metadata</th></tr>
		</thead>
		<tbody>
			{#each data.rows as e (e.id)}
				<tr>
					<td class="num">{formatDateTime(e.createdAt)}</td>
					<td>{e.type}</td>
					<td>{e.resource ?? '—'}{e.resourceId ? `: ${e.resourceId}` : ''}</td>
					<td class="muted">{e.workspaceId ?? '—'}</td>
					<td><pre class="meta">{meta(e.metadata)}</pre></td>
				</tr>
			{:else}
				<tr><td colspan="5"><EmptyState title="No system events recorded" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	.filters {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		margin: var(--space-md) 0;
	}
	.pick {
		width: 16rem;
	}
	.meta {
		margin: 0;
		max-width: 22rem;
		overflow-x: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
	}
</style>
