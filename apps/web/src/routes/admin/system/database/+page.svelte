<script lang="ts">
	import { formatTokens } from '$lib/format';
	import { Card, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
</script>

<PageHeader
	title="Database"
	lede="PostgreSQL state: connections, slow activity, table growth and dead rows."
/>
<Guide id="admin-system-database" />
<div class="fr-stats">
	<StatCard label="Database size" value={data.databaseSize ?? 'unavailable'} />
	<StatCard label="Connections" value={data.connections.length} />
	<StatCard label="Active queries" value={data.activeCount} />
	<StatCard label="Slow queries (>1s)" value={data.slowQueries.length} tone={data.slowQueries.length > 0 ? 'danger' : 'success'} />
	<StatCard label="request_log rows" value={data.requestLogRows === null ? 'unavailable' : formatTokens(data.requestLogRows)} />
	<StatCard label="request_log size" value={data.requestLogSize ?? 'unavailable'} />
	<StatCard
		label="Migration version"
		value={data.migration?.name ?? 'unknown'}
	/>
</div>
<div class="grid2">
	<Card>
		<h2 class="fr-label">Connections and activity</h2>
		<TableWrap label="PostgreSQL activity">
			<table class="fr">
				<thead><tr><th>PID</th><th>State</th><th>Duration</th><th>Query</th></tr></thead>
				<tbody>
					{#each data.connections as c (c.pid)}
						<tr>
							<td class="num">{c.pid}</td>
							<td>{c.state}</td>
							<td class="num"
								>{c.durationSeconds >= 1
									? `${c.durationSeconds.toFixed(1)} s`
									: `${Math.round(c.durationSeconds * 1000)} ms`}</td
							>
							<td class="muted mono">{c.query}</td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No client connections" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<h2 class="fr-label">Slow queries (running > 1s)</h2>
		<TableWrap label="Slow queries">
			<table class="fr">
				<thead><tr><th>PID</th><th>Duration</th><th>Query</th></tr></thead>
				<tbody>
					{#each data.slowQueries as q (q.pid)}
						<tr>
							<td class="num">{q.pid}</td>
							<td class="num"
								>{q.durationSeconds >= 1
									? `${q.durationSeconds.toFixed(1)} s`
									: `${Math.round(q.durationSeconds * 1000)} ms`}</td
							>
							<td class="muted mono">{q.query}</td>
						</tr>
					{:else}
						<tr><td colspan="3"><EmptyState title="No slow queries running" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
	<Card>
		<h2 class="fr-label">Dead rows and autovacuum</h2>
		<TableWrap label="Dead rows by table">
			<table class="fr">
				<thead><tr><th>Table</th><th>Dead rows</th><th>Last autovacuum</th></tr></thead>
				<tbody>
					{#each data.bloat as b (b.table)}
						<tr>
							<td>{b.table}</td>
							<td class="num">{formatTokens(b.deadRows)}</td>
							<td class="num">{b.lastAutovacuum ?? 'never'}</td>
						</tr>
					{:else}
						<tr><td colspan="3"><EmptyState title="No statistics available" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<h2 class="fr-label">Migration</h2>
		<p class="muted">
			{#if data.migration}
				Last applied: <strong>{data.migration.name}</strong>
				{#if data.migration.appliedAt}<span>at {String(data.migration.appliedAt)}</span>{/if}
			{:else}
				unknown — the schema_migration table is missing or empty.
			{/if}
		</p>
	</Card>
</div>
<style>
	.mono {
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}
</style>
