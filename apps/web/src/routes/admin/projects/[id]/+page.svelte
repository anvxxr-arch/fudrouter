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
<PageHeader
	title={data.project.name}
	lede="{data.project.slug} — environments, keys and usage."
/>
<p class="muted">
	<a href={resolve('/admin/projects')}>← All projects</a> ·
	<a href={resolve('/admin/workspaces/[id]', { id: data.project.workspaceId })}
		>{data.project.workspaceName}</a
	>
</p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.statusSet}<div class="fr-feedback"><Alert tone="success">Project updated.</Alert></div>{/if}
<Guide id="admin-project-detail" />
<Card>
	<h2 class="first">Project</h2>
	<Facts
		items={[
			{ term: 'Slug', detail: data.project.slug },
			{ term: 'Status', detail: data.project.status },
			{ term: 'Description', detail: data.project.description ?? '—' },
			{ term: 'Created', detail: formatDateTime(data.project.createdAt) },
			{ term: 'Updated', detail: formatDateTime(data.project.updatedAt) }
		]}
	/>
	<div class="fr-actions">
		<form method="POST" action="?/setStatus" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.project.id} />
			<Select name="status" aria-label="Project status">
				{#each data.statuses as s (s)}
					<option value={s} selected={s === data.project.status}>{s}</option>
				{/each}
			</Select>
			<Button type="submit" {pending}>Set status</Button>
		</form>
	</div>
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
	<h2 class="first">Environments</h2>
	<TableWrap label="Environments">
		<table class="fr">
			<thead>
				<tr><th>Name</th><th>Slug</th><th>Type</th><th>Status</th><th>Routing policy</th></tr>
			</thead>
			<tbody>
				{#each data.environments as e (e.id)}
					<tr>
						<td>{e.name}</td>
						<td>{e.slug}</td>
						<td>{e.type}</td>
						<td><Badge tone={statusTone(e.status)}>{e.status}</Badge></td>
						<td>{e.routingPolicyId ?? '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="5"><EmptyState title="No environments" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
</Card>
<Card>
	<h2 class="first">API keys</h2>
	<TableWrap label="API keys">
		<table class="fr">
			<thead>
				<tr>
					<th>Name</th><th>Prefix</th><th>Status</th><th>Last used</th><th>Revoked</th>
				</tr>
			</thead>
			<tbody>
				{#each data.keys as k (k.id)}
					<tr>
						<td>{k.name}</td>
						<td><code class="muted">sk-ar-{k.prefix}…</code></td>
						<td><Badge tone={k.status === 'active' ? 'success' : 'danger'}>{k.status}</Badge></td>
						<td class="num">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : '—'}</td>
						<td class="num">{k.revokedAt ? formatDateTime(k.revokedAt) : '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="5"><EmptyState title="No API keys" /></td></tr>
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
