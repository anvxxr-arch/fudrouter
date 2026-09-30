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
		StatCard,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader title={data.account.name} lede={data.account.email} />
<p class="muted"><a href={resolve('/admin/users')}>← All users</a></p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.suspended || form?.unsuspended || form?.accessDisabled}
	<div class="fr-feedback"><Alert tone="success">Account updated.</Alert></div>
{/if}
<Guide id="admin-user-detail" />
<Card>
	<h2 class="first">Account</h2>
	<Facts
		items={[
			{ term: 'Role', detail: data.account.role ?? 'user' },
			{
				term: 'Status',
				detail: data.account.banned ? 'suspended' : 'active'
			},
			{ term: 'Email verified', detail: data.account.emailVerified ? 'yes' : 'no' },
			{ term: 'Joined', detail: formatDateTime(data.account.createdAt) },
			{
				term: 'Last activity',
				detail: data.lastActivity ? formatDateTime(data.lastActivity) : '—'
			},
			{ term: 'Live sessions', detail: String(data.sessionCount) }
		]}
	/>
	<div class="fr-actions">
		<form method="POST" action="?/suspend" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.account.id} />
			<label class="confirm"><input type="checkbox" name="confirm" /> confirm</label>
			<Button type="submit" {pending} variant="danger">Suspend</Button>
		</form>
		<form method="POST" action="?/unsuspend" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.account.id} />
			<label class="confirm"><input type="checkbox" name="confirm" /> confirm</label>
			<Button type="submit" {pending}>Unsuspend</Button>
		</form>
		<form method="POST" action="?/disableAccess" use:enhance={track} class="fr-inline">
			<input type="hidden" name="id" value={data.account.id} />
			<label class="confirm"><input type="checkbox" name="confirm" /> confirm</label>
			<Button type="submit" {pending} variant="danger">Disable access</Button>
		</form>
	</div>
	<p class="muted">
		Suspend revokes sessions and blocks sign-in. Disable access keeps the account and role but
		revokes sessions and sets every API key to <code>disabled</code>.
	</p>
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
	<h2 class="first">Workspaces</h2>
	<TableWrap label="Workspaces">
		<table class="fr">
			<thead>
				<tr><th>Workspace</th><th>Role</th><th>Member status</th><th>Workspace status</th></tr>
			</thead>
			<tbody>
				{#each data.memberships as m (m.memberId)}
					<tr>
						<td>
							<a href={resolve('/admin/workspaces/[id]', { id: m.workspaceId })}>{m.workspaceName}</a>
							<span class="muted"> ({m.workspaceSlug})</span>
						</td>
						<td>{m.role}</td>
						<td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge></td>
						<td><Badge tone={m.workspaceStatus === 'active' ? 'success' : 'neutral'}>{m.workspaceStatus}</Badge></td>
					</tr>
				{:else}
					<tr><td colspan="4"><EmptyState title="No workspaces" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
</Card>
<Card>
	<h2 class="first">Projects</h2>
	<TableWrap label="Projects">
		<table class="fr">
			<thead><tr><th>Project</th><th>Workspace</th><th>Status</th></tr></thead>
			<tbody>
				{#each data.projects as p (p.id)}
					<tr>
						<td><a href={resolve('/admin/projects/[id]', { id: p.id })}>{p.name}</a></td>
						<td>{p.workspaceName}</td>
						<td><Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status}</Badge></td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No projects" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
</Card>
<Card>
	<h2 class="first">Billing</h2>
	<TableWrap label="Billing accounts">
		<table class="fr">
			<thead>
				<tr>
					<th>Workspace</th><th>Status</th><th>Balance</th><th>Cache</th>
				</tr>
			</thead>
			<tbody>
				{#each data.billing as b (b.accountId)}
					<tr>
						<td>{b.workspaceName}</td>
						<td><Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge></td>
						<td class="num">{formatCost(b.balanceMicro, b.currency)}</td>
						<td class="num">{formatCost(b.cachedBalanceMicro, b.currency)}</td>
					</tr>
				{:else}
					<tr><td colspan="4"><EmptyState title="No billing accounts" /></td></tr>
				{/each}
			</tbody>
		</table></TableWrap
	>
	<p class="muted">Balance is recomputed from the credit ledger; “Cache” is the cached column.</p>
</Card>
<Card>
	<h2 class="first">API keys</h2>
	<TableWrap label="API keys">
		<table class="fr">
			<thead>
				<tr><th>Name</th><th>Prefix</th><th>Status</th><th>Last used</th><th>Revoked</th></tr>
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
	.confirm {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.85rem;
	}
</style>
