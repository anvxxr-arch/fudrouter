<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCost, formatDateTime } from '$lib/format';
	import { Badge, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	const statusTone = (s: string) =>
		s === 'active' ? 'success' : s === 'suspended' ? 'danger' : 'neutral';
	let { data } = $props();
</script>
<PageHeader title="Projects" lede="One level down from workspaces: environments, keys and spend." />
<Guide id="admin-projects" />
<TableWrap label="Projects">
	<table class="fr">
		<thead>
			<tr>
				<th>Project</th><th>Workspace</th><th>Status</th><th>Environments</th><th>Keys</th><th
					>Requests</th
				><th>Spend</th><th>Created</th>
			</tr>
		</thead>
		<tbody>
			{#each data.projects as p (p.id)}
				<tr>
					<td>
						<a href={resolve('/admin/projects/[id]', { id: p.id })}>{p.name}</a><br />
						<span class="muted">{p.slug}</span>
					</td>
					<td>{p.workspaceName}</td>
					<td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
					<td class="num">{p.environments}</td>
					<td class="num">{p.keys}</td>
					<td class="num">{p.requests}</td>
					<td class="num">{formatCost(BigInt(p.cost))}</td>
					<td class="num">{formatDateTime(p.createdAt)}</td>
				</tr>
			{:else}
				<tr><td colspan="8"><EmptyState title="No projects" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
</style>
