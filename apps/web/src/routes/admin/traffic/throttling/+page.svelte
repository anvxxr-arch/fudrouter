<script lang="ts">
	import { formatDateTime } from '$lib/format';
	import { Badge, Card, EmptyState, Guide, PageHeader, TableWrap, Alert } from '$lib/ui';
	let { data } = $props();
</script>
<PageHeader
	title="Throttling"
	lede="Recent rate-limit rejections over the last 24 hours, grouped by key and project. Read-only — this is what the counters are doing."
/>
<Guide id="admin-traffic-throttling" />
<Card>
	<h2 class="first">Rejections per hour</h2>
	<TableWrap label="Rejections per hour">
		<table class="fr">
			<thead><tr><th>Hour</th><th>API key</th><th>Project</th><th>Rejections</th></tr></thead>
			<tbody>
				{#each data.hourly as h (h.hour + (h.apiKeyId ?? '') + (h.projectId ?? ''))}
					<tr>
						<td class="num">{h.hour}</td>
						<td>{h.keyName ?? h.apiKeyId ?? '—'}</td>
						<td>{h.projectName ?? h.projectId ?? '—'}</td>
						<td class="num">{h.n.toLocaleString()}</td>
					</tr>
				{:else}
					<tr><td colspan="4"><EmptyState title="No throttling in the last 24 hours" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="first">Live concurrency counters</h2>
	{#if !data.valkeyUp}
		<Alert tone="info">Valkey is not configured — live concurrency gauges are unavailable.</Alert>
	{:else}
		<TableWrap label="Concurrency counters">
			<table class="fr">
				<thead><tr><th>Counter</th><th>In flight</th></tr></thead>
				<tbody>
					{#each data.concurrency as c (c.key)}
						<tr><td><code>{c.key}</code></td><td class="num">{c.inFlight}</td></tr>
					{:else}
						<tr><td colspan="2"><EmptyState title="Nothing in flight right now" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}
</Card>
<Card>
	<h2 class="first">Recent rejections</h2>
	<TableWrap label="Recent rejections">
		<table class="fr">
			<thead>
				<tr><th>When</th><th>API key</th><th>Project</th><th>Status</th><th>Error</th></tr>
			</thead>
			<tbody>
				{#each data.recent as r (r.id)}
					<tr>
						<td class="num">{formatDateTime(new Date(r.createdAt))}</td>
						<td>{r.keyName ?? r.apiKeyId ?? '—'}</td>
						<td>{r.projectName ?? r.projectId ?? '—'}</td>
						<td><Badge tone="warning">{r.status}</Badge></td>
						<td>{r.errorCode ?? '—'}{r.httpStatus ? ` (${r.httpStatus})` : ''}</td>
					</tr>
				{:else}
					<tr><td colspan="5"><EmptyState title="No rate-limit rejections recorded" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
