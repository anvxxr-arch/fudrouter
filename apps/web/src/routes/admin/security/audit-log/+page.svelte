<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { Badge, Button, ButtonLink, Card, EmptyState, Field, Guide, PageHeader, Select, TableWrap } from '$lib/ui';
	let { data } = $props();
	let open = $state<string | null>(null);
	function toggle(id: string) {
		open = open === id ? null : id;
	}
</script>
<PageHeader
	title="Audit log"
	lede="Every mutating admin action, newest first. Secret values are dropped at write and read time — a redacted key is never shown."
/>
<Guide id="admin-audit-log" />
<form class="filters" method="GET">
	<div class="pick">
		<Field label="Action">
			<Select name="action">
				<option value="" selected={!data.action}>All actions</option>
				{#each data.actions as a (a.action)}
					<option value={a.action} selected={data.action === a.action}>{a.action} ({a.n})</option>
				{/each}
			</Select>
		</Field>
	</div>
	<Button type="submit">Filter</Button>
</form>
<Card>
	<TableWrap label="Audit entries">
		<table class="fr">
			<thead>
				<tr>
					<th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Changes</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="num">{formatDateTime(r.createdAt)}</td>
						<td>{r.actorEmail ?? r.actorKind}</td>
						<td><Badge tone="info">{r.action}</Badge></td>
						<td>{r.resource}{r.resourceId ? `: ${r.resourceId}` : ''}</td>
						<td>
							{#if r.before || r.after}
								<Button variant="ghost" size="sm" onclick={() => toggle(r.id)}>
									{open === r.id ? 'Hide' : 'Show'} diff
								</Button>
							{:else}
								—
							{/if}
							{#if open === r.id}
								<div class="diff">
									{#if r.before}<pre>before: {JSON.stringify(r.before, null, 2)}</pre>{/if}
									{#if r.after}<pre>after: {JSON.stringify(r.after, null, 2)}</pre>{/if}
								</div>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="5"><EmptyState title="No audit entries" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<nav class="pager" aria-label="Audit log pages">
	{#if data.page > 1}
		<ButtonLink variant="ghost" size="sm" href={`?page=${data.page - 1}${data.action ? `&action=${data.action}` : ''}`}>Newer</ButtonLink>
	{/if}
	<span class="muted">Page {data.page}</span>
	{#if data.rows.length === 100}
		<ButtonLink variant="ghost" size="sm" href={`?page=${data.page + 1}${data.action ? `&action=${data.action}` : ''}`}>Older</ButtonLink>
	{/if}
</nav>
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
	.diff {
		margin-top: var(--space-sm);
	}
	.diff pre {
		white-space: pre-wrap;
		word-break: break-word;
		font-size: var(--text-sm);
		background: var(--color-surface-raised);
		padding: var(--space-sm);
		border-radius: var(--radius-md);
	}
	.pager {
		display: flex;
		gap: var(--space-md);
		align-items: center;
		margin-top: var(--space-md);
	}
</style>
