<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatDateTime } from '$lib/format';
	import {
		Badge,
		ButtonLink,
		Card,
		EmptyState,
		Guide,
		PageHeader,
		StatCard,
		TableWrap
	} from '$lib/ui';
	let { data } = $props();
	function snippet(value: unknown): string {
		const s = JSON.stringify(value);
		return s && s !== '{}' ? (s.length > 80 ? s.slice(0, 80) + '…' : s) : '—';
	}
	const SEVERITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
		critical: 'danger',
		major: 'warning',
		minor: 'neutral'
	};
</script>

<PageHeader
	title="System"
	lede="PostgreSQL, Valkey, workers and incidents. Every number here is read live."
/>
<Guide id="admin-system" />
<div class="fr-stats">
	<StatCard label="Database size" value={data.database?.size ?? 'unavailable'} />
	<StatCard label="DB connections" value={data.database?.connections ?? 'unavailable'} />
	<StatCard
		label="Valkey"
		value={data.valkey}
		tone={data.valkey === 'up' ? 'success' : data.valkey === 'down' ? 'danger' : 'neutral'}
	/>
	<StatCard label="Job backlog" value={data.backlog} />
	<StatCard
		label="Open incidents"
		value={data.openIncidents.length}
		tone={data.openIncidents.length > 0 ? 'danger' : 'success'}
	/>
</div>
<div class="grid2">
	<Card>
		<h2 class="fr-label">Drill down</h2>
		<div class="links">
			<ButtonLink href={resolve('/admin/system/health')}>Health</ButtonLink>
			<ButtonLink href={resolve('/admin/system/metrics')}>Metrics</ButtonLink>
			<ButtonLink href={resolve('/admin/system/valkey')}>Valkey</ButtonLink>
			<ButtonLink href={resolve('/admin/system/database')}>Database</ButtonLink>
			<ButtonLink href={resolve('/admin/system/workers')}>Workers</ButtonLink>
			<ButtonLink href={resolve('/admin/system/jobs')}>Jobs</ButtonLink>
			<ButtonLink href={resolve('/admin/system/events')}>Events</ButtonLink>
			<ButtonLink href={resolve('/admin/incidents')}>Incidents</ButtonLink>
		</div>
		<h2 class="fr-label">Job queue by status</h2>
		<table class="fr">
			<thead><tr><th>Status</th><th>Jobs</th></tr></thead>
			<tbody>
				{#each data.jobCounts as j (j.status)}
					<tr><td>{j.status}</td><td class="num">{j.n.toLocaleString()}</td></tr>
				{:else}
					<tr><td colspan="2"><EmptyState title="No jobs queued" /></td></tr>
				{/each}
			</tbody>
		</table>
	</Card>
	<Card>
		<h2 class="fr-label">Open incidents</h2>
		<table class="fr">
			<thead><tr><th>Component</th><th>Title</th><th>Severity</th><th>Status</th></tr></thead>
			<tbody>
				{#each data.openIncidents as i (i.id)}
					<tr>
						<td>{i.component}</td>
						<td>{i.title}</td>
						<td><Badge tone={SEVERITY_TONE[i.severity] ?? 'neutral'}>{i.severity}</Badge></td>
						<td>{i.status}</td>
					</tr>
				{:else}
					<tr><td colspan="4"><EmptyState title="No open incidents" /></td></tr>
				{/each}
			</tbody>
		</table>
	</Card>
</div>
<TableWrap label="Recent system events">
	<table class="fr">
		<thead>
			<tr><th>When</th><th>Type</th><th>Resource</th><th>Detail</th></tr>
		</thead>
		<tbody>
			{#each data.events as e (e.id)}
				<tr>
					<td class="num">{formatDateTime(e.createdAt)}</td>
					<td>{e.type}</td>
					<td>{e.resource ?? '—'}{e.resourceId ? `: ${e.resourceId}` : ''}</td>
					<td class="muted">{snippet(e.metadata)}</td>
				</tr>
			{:else}
				<tr><td colspan="4"><EmptyState title="No system events recorded" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-bottom: var(--space-md);
	}
</style>
