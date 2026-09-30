<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { formatCost, formatDateTime, formatTokens } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Facts,
		Guide,
		PageHeader,
		Select,
		StatCard,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const statusTone = (s: string) =>
		s === 'active' ? 'success' : s === 'suspended' ? 'danger' : 'neutral';
</script>
<PageHeader title={data.workspace.name} lede="{data.workspace.slug} — members, projects and spend." />
<p class="muted"><a href={resolve('/admin/workspaces')}>← All workspaces</a></p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.statusSet || form?.suspended || form?.unsuspended}
	<div class="fr-feedback"><Alert tone="success">Workspace updated.</Alert></div>
{/if}
<Guide id="admin-workspace-detail" />
<Card>
	<h2 class="first">Workspace</h2>
	<Facts
		items={[
			{ term: 'Slug', detail: data.workspace.slug },
			{ term: 'Status', detail: data.workspace.status },
			{ term: 'Owner', detail: data.workspace.ownerEmail ?? '—' },
			{ term: 'Created', detail: formatDateTime(data.workspace.createdAt) },
			{ term: 'Updated', detail: formatDateTime(data.workspace.updatedAt) }
		]}
	/>
	<div class="fr-actions">
		<form method="POST" action="?/setStatus" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.workspace.id} />
			<Select name="status" aria-label="Workspace status">
				{#each data.statuses as s (s)}
					<option value={s} selected={s === data.workspace.status}>{s}</option>
				{/each}
			</Select>
			<Button type="submit" {pending}>Set status</Button>
		</form>
		<form method="POST" action="?/suspend" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.workspace.id} />
			<Button type="submit" {pending} variant="danger">Suspend</Button>
		</form>
		<form method="POST" action="?/unsuspend" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.workspace.id} />
			<Button type="submit" {pending}>Unsuspend</Button>
		</form>
	</div>
	<p class="muted">Suspending the workspace also suspends every project it owns.</p>
</Card>
<Card>
	<h2 class="first">Usage</h2>
	<div class="stats">
		<StatCard label="Requests" value={data.usage.requests} />
		<StatCard label="Tokens in" value={formatTokens(data.usage.tokensIn)} />
		<StatCard label="Tokens out" value={formatTokens(data.usage.tokensOut)} />
		<StatCard label="Cost" value={formatCost(BigInt(data.usage.cost))} />
	</div>
</Card>
<Card>
	<h2 class="first">Billing</h2>
	{#if data.billing}
		<Facts
			items={[
				{ term: 'Status', detail: data.billing.status },
				{ term: 'Balance', detail: formatCost(data.billing.balanceMicro, data.billing.currency) },
				{
					term: 'Cache',
					detail: formatCost(data.billing.cachedBalanceMicro, data.billing.currency)
				}
			]}
		/>
		<p class="muted">Balance is recomputed from the credit ledger; “Cache” is the cached column.</p>
	{:else}
		<EmptyState title="No billing account" />
	{/if}
</Card>
<Card>
	<h2 class="first">Members</h2>
	<TableWrap label="Members">
		<table class="fr">
			<thead><tr><th>User</th><th>Role</th><th>Status</th></tr></thead>
			<tbody>
				{#each data.members as m (m.memberId)}
					<tr>
						<td>
							<a href={resolve('/admin/users/[id]', { id: m.userId })}>{m.userName}</a><br />
							<span class="muted">{m.userEmail}</span>
						</td>
						<td>{m.role}</td>
						<td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge></td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No members" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
</Card>
<Card>
	<h2 class="first">Projects</h2>
	<TableWrap label="Projects">
		<table class="fr">
			<thead><tr><th>Project</th><th>Status</th><th>Created</th></tr></thead>
			<tbody>
				{#each data.projects as p (p.id)}
					<tr>
						<td>
							<a href={resolve('/admin/projects/[id]', { id: p.id })}>{p.name}</a><br />
							<span class="muted">{p.slug}</span>
						</td>
						<td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
						<td class="num">{formatDateTime(p.createdAt)}</td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No projects" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
</Card>
<style>
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
	}
</style>
