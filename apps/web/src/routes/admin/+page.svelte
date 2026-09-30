<script lang="ts">
	import { formatCost, formatDateTime, formatTokens } from '$lib/format';
	import { resolve } from '$app/paths';
	import { Badge, Card, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader title="Admin overview" lede="Deployment-wide state, newest facts first." />
<div class="fr-stats">
	<StatCard label="Providers" value={data.counts.providers} />
	<StatCard label="Models" value={data.counts.models} />
	<StatCard label="Connections" value={data.counts.connections} />
	<StatCard label="Active keys" value={data.counts.activeKeys} />
	<StatCard label="Users" value={data.counts.users} />
	<StatCard label="Requests" value={data.counts.requests} />
	<StatCard label="Tokens" value={formatTokens(data.counts.tokens)} />
	<StatCard label="Cost (all time)" value={formatCost(BigInt(data.counts.costMicro))} />
</div>
<div class="grid2">
	<Card>
		<h2 class="fr-label">Top consumers</h2>
		<TableWrap label="Top consumers by cost">
			<table class="fr">
				<thead><tr><th>Key</th><th>User</th><th>Requests</th><th>Cost</th></tr></thead>
				<tbody>
					{#each data.topConsumers as t (t.keyId ?? t.email)}
						<tr>
							<td>{t.keyName}</td>
							<td>{t.email}</td>
							<td class="num">{t.requests.toLocaleString()}</td>
							<td class="num">{formatCost(BigInt(t.costMicro))}</td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No usage recorded" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
	<Card>
		<h2 class="fr-label">Recent calls</h2>
		<TableWrap label="Recent calls">
			<table class="fr">
				<thead><tr><th>When</th><th>Model</th><th>Latency</th><th>Status</th></tr></thead>
				<tbody>
					{#each data.recent as r (r.id)}
						<tr>
							<td class="num"><a href={resolve('/admin/requests/[id]', { id: r.id })}>{formatDateTime(r.createdAt)}</a></td>
							<td>{r.requestedModel ?? '—'}</td>
							<td class="num">{r.latencyMs.toLocaleString()} ms</td>
							<td>
								<Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
							</td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No calls recorded" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
</div>
<Guide id="admin" />
<style>
	.grid2 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr));
		gap: var(--space-lg);
	}
</style>
