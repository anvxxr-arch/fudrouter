<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCost, formatDateTime } from '$lib/format';
	import { Badge, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	const statusTone = (s: string) =>
		s === 'active' ? 'success' : s === 'suspended' ? 'danger' : 'neutral';
	let { data } = $props();
</script>
<PageHeader title="Workspaces" lede="Every account container, its owner and its spend." />
<Guide id="admin-workspaces" />
<TableWrap label="Workspaces">
	<table class="fr">
		<thead>
			<tr>
				<th>Workspace</th><th>Owner</th><th>Status</th><th>Members</th><th>Projects</th><th
					>Requests</th
				><th>Spend</th><th>Balance</th><th>Created</th>
			</tr>
		</thead>
		<tbody>
			{#each data.workspaces as w (w.id)}
				<tr>
					<td>
						<a href={resolve('/admin/workspaces/[id]', { id: w.id })}>{w.name}</a><br />
						<span class="muted">{w.slug}</span>
					</td>
					<td>{w.ownerEmail ?? '—'}</td>
					<td><Badge tone={statusTone(w.status)}>{w.status}</Badge></td>
					<td class="num">{w.members}</td>
					<td class="num">{w.projects}</td>
					<td class="num">{w.requests}</td>
					<td class="num">{formatCost(BigInt(w.cost))}</td>
					<td class="num">{formatCost(w.balanceMicro)}</td>
					<td class="num">{formatDateTime(w.createdAt)}</td>
				</tr>
			{:else}
				<tr><td colspan="9"><EmptyState title="No workspaces" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
</style>
