<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { Badge, Card, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	import type { ComponentHealth } from './+page.server';
	let { data } = $props();
	const HEALTH_TONE: Record<ComponentHealth, 'success' | 'warning' | 'danger'> = {
		operational: 'success',
		degraded: 'warning',
		outage: 'danger'
	};
</script>

<PageHeader
	title="Component health"
	lede="Per-component status for the status page: 24h success rate, open incidents and the latest health snapshot."
/>
<Guide id="admin-system-health" />
{#each data.components as p (p.id)}
	<Card>
		<div class="head">
			<h2 class="fr-label">{p.name}</h2>
			<Badge tone={HEALTH_TONE[p.health]}>{p.health}</Badge>
		</div>
		<p class="muted">
			24h success rate {p.successRate === null ? 'no traffic' : `${p.successRate.toFixed(2)}%`} over
			{p.requests.toLocaleString()} requests · latest snapshot {p.snapshot ?? 'none'}
		</p>
		{#if p.incidents.length > 0}
			<ul class="incidents">
				{#each p.incidents as i (i.id)}
					<li>
						<Badge tone={i.severity === 'critical' ? 'danger' : 'warning'}>{i.severity}</Badge>
						{i.title} <span class="muted">({i.status}, since {formatDateTime(i.startedAt)})</span>
					</li>
				{/each}
			</ul>
		{/if}
		<TableWrap label="Connections for {p.name}">
			<table class="fr">
				<thead>
					<tr>
						<th>Connection</th><th>Health</th><th>Probe</th><th>24h success</th><th>Requests</th><th
							>Incidents</th
						>
					</tr>
				</thead>
				<tbody>
					{#each p.connections as c (c.id)}
						<tr>
							<td>{c.name}{c.enabled ? '' : ' (disabled)'}</td>
							<td><Badge tone={HEALTH_TONE[c.health]}>{c.health}</Badge></td>
							<td>{c.healthStatus}</td>
							<td class="num">{c.successRate === null ? 'no traffic' : `${c.successRate.toFixed(2)}%`}</td>
							<td class="num">{c.requests.toLocaleString()}</td>
							<td>{c.incidents.length > 0 ? c.incidents.map((i) => i.title).join('; ') : '—'}</td>
						</tr>
					{:else}
						<tr><td colspan="6"><EmptyState title="No connections" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
{:else}
	<EmptyState title="No providers" hint="Add a provider to see component health." />
{/each}
<style>
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}
	.incidents {
		margin: var(--space-sm) 0;
		padding-left: var(--space-md);
	}
</style>
