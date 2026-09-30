<script lang="ts">
	import { resolve } from '$app/paths';
	import { ButtonLink, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader
	title="Team"
	lede="Who has access to this workspace, and how the seats are used."
/>
<div class="stats">
	<StatCard label="Members" value={data.memberCount} />
	<StatCard
		label="Pending invitations"
		value={data.pendingCount}
		tone={data.pendingCount > 0 ? 'success' : 'neutral'}
	/>
</div>
<div class="links">
	<ButtonLink variant="primary" href={resolve('/dashboard/team/members')}>Manage members</ButtonLink>
	<ButtonLink href={resolve('/dashboard/team/invitations')}>Invitations</ButtonLink>
	<ButtonLink href={resolve('/dashboard/team/roles')}>Roles</ButtonLink>
</div>
<Guide id="team" />
<h2>Role usage</h2>
<TableWrap label="Role usage">
	<table class="fr">
		<thead>
			<tr><th>Role</th><th>Members</th></tr>
		</thead>
		<tbody>
			{#each data.roles as r (r.name)}
				<tr><td>{r.name}</td><td class="num">{r.count}</td></tr>
			{:else}
				<tr><td colspan="2">No members yet.</td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
	.stats {
		display: flex;
		gap: var(--space-md);
		flex-wrap: wrap;
	}
	.links {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		margin-top: var(--space-md);
	}
</style>
