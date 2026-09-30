<script lang="ts">
	import { formatDateTime, formatTokens } from '$lib/format';
	import { Card, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
	const totals = $derived(
		data.groups.reduce(
			(acc: Record<string, number>, g: { status: string; n: number }) => {
				acc[g.status] = (acc[g.status] ?? 0) + g.n;
				return acc;
			},
			{} as Record<string, number>
		)
	);
</script>

<PageHeader
	title="Workers"
	lede="Background workers claiming jobs from PostgreSQL with FOR UPDATE SKIP LOCKED."
/>
<Guide id="admin-system-workers" />
<div class="fr-stats">
	<StatCard label="Running" value={totals.running ?? 0} />
	<StatCard label="Pending" value={totals.pending ?? 0} />
	<StatCard label="Failed" value={totals.failed ?? 0} tone={totals.failed ? 'danger' : 'neutral'} />
	<StatCard label="Done" value={totals.done ?? 0} />
</div>
<div class="grid2">
	<Card>
		<h2 class="fr-label">Jobs in flight</h2>
		<TableWrap label="Running jobs">
			<table class="fr">
				<thead>
					<tr><th>Job</th><th>Type</th><th>Attempts</th><th>Started</th><th>Available since</th></tr>
				</thead>
				<tbody>
					{#each data.running as j (j.id)}
						<tr>
							<td class="mono">{j.id}</td>
							<td>{j.type}</td>
							<td class="num">{j.attempts} / {j.maxAttempts}</td>
							<td class="num">{j.startedAt ? formatDateTime(j.startedAt) : '—'}</td>
							<td class="num">{formatDateTime(j.availableAt)}</td>
						</tr>
					{:else}
						<tr><td colspan="5"><EmptyState title="No jobs running right now" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
	<Card>
		<h2 class="fr-label">Queue by type and status</h2>
		<TableWrap label="Jobs grouped by status and type">
			<table class="fr">
				<thead><tr><th>Status</th><th>Type</th><th>Jobs</th></tr></thead>
				<tbody>
					{#each data.groups as g (g.status + g.type)}
						<tr>
							<td>{g.status}</td>
							<td>{g.type}</td>
							<td class="num">{formatTokens(g.n)}</td>
						</tr>
					{:else}
						<tr><td colspan="3"><EmptyState title="No jobs in the queue" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
</div>
<style>
	.mono {
		font-family: var(--font-mono, monospace);
	}
</style>
