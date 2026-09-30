<script lang="ts">
	import { formatCost, formatDateTime } from '$lib/format';
	import { Alert, Badge, Card, EmptyState, Guide, PageHeader, StatCard, TableWrap } from '$lib/ui';
	let { data } = $props();
	const totalRequests = $derived(data.windows.reduce((n, w) => n + w.requests, 0));
	const totalErrors = $derived(data.windows.reduce((n, w) => n + w.errorCount, 0));
	const totalAuthFails = $derived(data.windows.reduce((n, w) => n + w.authFailures, 0));
	const totalSpend = $derived(data.windows.reduce((s, w) => s + w.spendMicro, 0n));
	const budgetMicro = $derived(data.windows[0]?.budgetMicro ?? null);
</script>
<PageHeader
	title="Abuse signals"
	lede="Threshold rules evaluated over hourly SQL windows, newest window first. Each signal names the exact count that tripped it."
/>
<Alert tone="info">
	Every number here is a plain SQL count over request_log and audit_log. Rules compare counts to
	thresholds and nothing else — no classifier and no external call is made.
</Alert>
<div class="stats">
	<StatCard label="Requests ({data.windowHours}h)" value={totalRequests} />
	<StatCard label="Auth failures ({data.windowHours}h)" value={totalAuthFails} tone={totalAuthFails > 0 ? 'warning' : 'neutral'} />
	<StatCard label="Failed requests ({data.windowHours}h)" value={totalErrors} tone={totalErrors > 0 ? 'warning' : 'neutral'} />
	<StatCard label="Spend ({data.windowHours}h)" value={formatCost(totalSpend)} />
	<StatCard label="Fired signals" value={data.signals.length} tone={data.signals.length > 0 ? 'danger' : 'neutral'} />
</div>
<p class="muted">
	{data.enabledRuleCount} of {data.ruleCount} signal rules enabled. Key-lifecycle actions counted:
	<code>{data.watchedActions.join(', ')}</code>
	— matched in window: {#if data.matchedActions.length}<code>{data.matchedActions.join(', ')}</code>{:else}none{/if}.
	Platform budget: {budgetMicro === null ? 'none set' : formatCost(budgetMicro)}.
</p>
<Guide id="admin-security-abuse" />
<Card>
	<h2 class="first">Fired signals</h2>
	<TableWrap label="Fired signals">
		<table class="fr">
			<thead>
				<tr>
					<th>When</th><th>Rule</th><th>Kind</th><th>Action</th><th>Window</th><th>Observed vs threshold</th><th>Message</th>
				</tr>
			</thead>
			<tbody>
				{#each data.signals as s (s.ruleId + s.at.toISOString())}
					<tr>
						<td class="num">{formatDateTime(s.at)}</td>
						<td>{s.name}</td>
						<td><Badge tone="info">{s.kind}</Badge></td>
						<td><Badge tone={s.action === 'block' ? 'danger' : 'neutral'}>{s.action}</Badge></td>
						<td class="num">{s.windowSeconds}s</td>
						<td class="num">{s.value} / {s.threshold}</td>
						<td>{s.message}</td>
					</tr>
				{:else}
					<tr><td colspan="7"><EmptyState title="No signals fired" hint="No enabled rule tripped on any window in the trailing period." /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<Card>
	<h2>Hourly windows</h2>
	<TableWrap label="Hourly windows">
		<table class="fr">
			<thead>
				<tr>
					<th>Window (UTC)</th><th>Requests</th><th>Auth fails</th><th>Errors</th><th>Distinct IPs</th><th>Top-IP share</th><th>Key rotations</th><th>Cred auth fails</th><th>Spend</th>
				</tr>
			</thead>
			<tbody>
				{#each data.windows as w (w.windowStart.toISOString())}
					<tr>
						<td class="num">{formatDateTime(w.windowStart)}</td>
						<td class="num">{w.requests}</td>
						<td class="num">{w.authFailures}</td>
						<td class="num">{w.errorCount}</td>
						<td class="num">{w.distinctIps}</td>
						<td class="num">{(w.topIpShare * 100).toFixed(0)}%</td>
						<td class="num">{w.keyRotations}</td>
						<td class="num">{w.credentialAuthFailures}</td>
						<td class="num">{formatCost(w.spendMicro)}</td>
					</tr>
				{:else}
					<tr><td colspan="9"><EmptyState title="No traffic in the trailing window" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	<p class="muted">
		Auth fails = <code>error_code = 'AUTHENTICATION_ERROR'</code>. Errors = non-success rows. Cred
		auth fails = provider-level <code>http_status in (401, 403)</code>. Top-IP share = busiest
		address's requests ÷ window total. Key rotations = key-lifecycle audit actions in the hour.
	</p>
</Card>
<style>
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin: var(--space-md) 0;
	}
</style>
