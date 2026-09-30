<script lang="ts">
	import { Badge, Card, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	let { data } = $props();
	// Badge tone by observed health: healthy→success, degraded→warning,
	// unhealthy/outage→danger. Unknown and disabled stay neutral.
	type Tone = 'success' | 'warning' | 'danger' | 'neutral';
	const toneFor = (state: string): Tone =>
		state === 'healthy' || state === 'operational' || state === 'active'
			? 'success'
			: state === 'degraded'
				? 'warning'
				: state === 'unhealthy' || state === 'outage'
					? 'danger'
					: 'neutral';
	const rate = (requests: number, successes: number): string =>
		requests === 0 ? '—' : `${((successes / requests) * 100).toFixed(1)}%`;
	const mix = (rows: { code: string; n: number }[]): string =>
		rows.length === 0 ? '—' : rows.map((e) => `${e.code} ×${e.n}`).join(', ');
</script>
<PageHeader
	title="Health"
	lede="Observed outcomes per provider and connection over the last 24 hours, plus the stored health state."
/>
<Guide id="admin-health" />
<Card>
	<h2 class="first">Providers</h2>
	<TableWrap label="Provider health">
		<table class="fr">
			<thead>
				<tr
					><th>Provider</th><th>Status</th><th>Requests</th><th>Success rate</th><th>P95</th
					><th>Error mix</th></tr
				>
			</thead>
			<tbody>
				{#each data.providers as p (p.id)}
					<tr>
						<td>{p.name}</td>
						<td><Badge tone={toneFor(p.status)}>{p.status}</Badge></td>
						<td class="num">{p.requests.toLocaleString()}</td>
						<td class="num">{rate(p.requests, p.successes)}</td>
						<td class="num">{p.p95.toLocaleString()} ms</td>
						<td>{mix(p.errorMix)}</td>
					</tr>
				{:else}
					<tr><td colspan="6"><EmptyState title="No providers configured" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2 class="first">Connections</h2>
	<TableWrap label="Connection health">
		<table class="fr">
			<thead>
				<tr
					><th>Connection</th><th>Provider</th><th>Health</th><th>Requests</th><th>Success rate</th
					><th>P95</th><th>Error mix</th><th>Credentials</th></tr
				>
			</thead>
			<tbody>
				{#each data.connections as c (c.id)}
					<tr>
						<td>{c.name}{c.region ? ` (${c.region})` : ''}</td>
						<td>{data.providers.find((p) => p.id === c.providerId)?.name ?? c.providerId}</td>
						<td><Badge tone={toneFor(c.healthStatus)}>{c.healthStatus}</Badge></td>
						<td class="num">{c.requests.toLocaleString()}</td>
						<td class="num">{rate(c.requests, c.successes)}</td>
						<td class="num">{c.p95.toLocaleString()} ms</td>
						<td>{mix(c.errorMix)}</td>
						<td
							><Badge tone={c.credentialsHealthy === c.credentialsTotal ? 'success' : 'warning'}
								>{c.credentialsHealthy}/{c.credentialsTotal} healthy</Badge
							></td
						>
					</tr>
				{:else}
					<tr><td colspan="8"><EmptyState title="No connections configured" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
