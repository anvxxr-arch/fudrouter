<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { formatCost, formatDateTime } from '$lib/format';
	import { Alert, Badge, Button, EmptyState, Guide, PageHeader, Select, TableWrap } from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader title="Users" lede="Roles decide which admin surfaces a user can reach." />
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
<Guide id="admin-users" />
<TableWrap label="Users">
	<table class="fr">
		<thead>
			<tr>
				<th>User</th><th>Role</th><th>Workspaces</th><th>Projects</th><th>Keys</th><th
					>Requests</th
				><th>Spend</th><th>Last activity</th><th>Status</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.users as u (u.id)}
				<tr>
					<td>
						<a href={resolve('/admin/users/[id]', { id: u.id })}>{u.name}</a><br />
						<span class="muted">{u.email}</span>
					</td>
					<td>
						<form method="POST" action="?/setRole" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={u.id} />
							<!-- Named per row: 13 identical "role" selects would each be
							     announced as just "combobox" otherwise. -->
							<Select name="role" aria-label="Role for {u.email}">
								{#each data.roles as r (r)}
									<option value={r} selected={r === (u.role ?? 'user')}>{r}</option>
								{/each}
							</Select>
							<Button type="submit" {pending} aria-label="Set role for {u.email}">Set</Button>
						</form>
					</td>
					<td class="num">{u.workspaces}</td>
					<td class="num">{u.projects}</td>
					<td class="num">{u.keys}</td>
					<td class="num">{u.requests}</td>
					<td class="num">{formatCost(BigInt(u.cost))}</td>
					<td class="num">{u.lastActivity ? formatDateTime(u.lastActivity) : '—'}</td>
					<td>
						<Badge tone={u.banned ? 'danger' : 'success'}>{u.banned ? 'banned' : 'active'}</Badge>
					</td>
					<td class="fr-actions">
						<form method="POST" action="?/toggleBan" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={u.id} />
							<Button
								type="submit"
								{pending}
								variant="danger"
								aria-label="{u.banned ? 'Unban' : 'Ban'} {u.email}"
							>
								{u.banned ? 'Unban' : 'Ban'}
							</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="10"><EmptyState title="No users" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
</style>
