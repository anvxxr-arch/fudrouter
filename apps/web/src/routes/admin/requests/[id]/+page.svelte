<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import { formatPricePer1M } from '$lib/public-format';
	import { Alert, Badge, Card, Facts, Guide, PageHeader, TableWrap } from '$lib/ui';

	let { data } = $props();
	const d = $derived(data.detail);
	// NULL = provider did not report; 0 = reported zero (PRD §122).
	const token = (n: number | null): string => (n === null ? 'not reported' : formatTokens(n));
	const ms = (n: number | null): string => (n === null ? '—' : `${n.toLocaleString()} ms`);
	const cost = (c: bigint | null): string => (c === null ? '—' : formatCost(c, d.currency));
	const price = (p: string | null): string => formatPricePer1M(p, d.currency);
	const bool = (b: boolean): string => (b ? 'yes' : 'no');
</script>

<PageHeader title="Request {d.id}" lede="{d.requestedModel ?? 'unknown model'} — {formatDateTime(d.createdAt)}" />
<Guide id="admin-request-detail" />
<p class="muted"><a href={resolve('/admin/requests')}>← All requests</a></p>

<Card>
	<h2 class="first">Identity</h2>
	<Facts
		items={[
			{ term: 'User', detail: d.email ?? '—' },
			{ term: 'API key', detail: d.keyName ? `${d.keyName} (${d.keyPrefix ?? '—'})` : '—' },
			{ term: 'Workspace', detail: d.workspaceId ?? '—' },
			{ term: 'Project', detail: d.projectId ?? '—' },
			{ term: 'Environment', detail: d.environmentId ?? '—' },
			{ term: 'Endpoint', detail: d.endpoint ?? '—' },
			{ term: 'Created', detail: formatDateTime(d.createdAt) }
		]}
	/>
</Card>

<Card>
	<h2 class="first">Routing</h2>
	<Facts
		items={[
			{ term: 'Requested model', detail: d.requestedModel ?? '—' },
			{ term: 'Resolved model', detail: d.modelSlug ?? '—' },
			{ term: 'Upstream model id', detail: d.upstreamModelId ?? '—' },
			{ term: 'Provider', detail: d.providerName ?? '—' },
			{ term: 'Connection', detail: d.connectionName ?? '—' },
			{ term: 'Credential', detail: d.credentialId ?? '—' },
			{ term: 'Routing policy', detail: d.routingPolicyId ?? '—' },
			{ term: 'Strategy', detail: d.strategy ?? '—' }
		]}
	/>
	<p class="muted">Credential shown by id only; secrets are never selectable here.</p>
</Card>

<Card>
	<h2 class="first">Outcome</h2>
	<p>
		<Badge tone={d.status === 'success' ? 'success' : 'danger'}>{d.status}</Badge>
		{#if d.errorCode}<code>{d.errorCode}</code>{/if}
		{#if d.httpStatus != null}<span class="muted">HTTP {d.httpStatus}</span>{/if}
	</p>
	{#if d.error}<p>{d.error}</p>{/if}
	<Facts
		items={[
			{ term: 'Attempts', detail: String(d.attempts) },
			{ term: 'Fallback used', detail: bool(d.fallbackUsed) },
			{ term: 'Stream', detail: bool(d.stream) },
			{ term: 'Client disconnected', detail: bool(d.clientDisconnected) }
		]}
	/>
</Card>

<Card>
	<h2 class="first">Tokens</h2>
	<Facts
		items={[
			{ term: 'Input', detail: token(d.tokensIn) },
			{ term: 'Cached input', detail: token(d.cachedInputTokens) },
			{ term: 'Reasoning', detail: token(d.reasoningTokens) },
			{ term: 'Output', detail: token(d.tokensOut) },
			{ term: 'Total', detail: token(d.totalTokens) }
		]}
	/>
</Card>

<Card>
	<h2 class="first">Pricing snapshot</h2>
	<Facts
		items={[
			{ term: 'Input price / 1M', detail: price(d.inputPriceMicro) },
			{ term: 'Cached input price / 1M', detail: price(d.cachedInputPriceMicro) },
			{ term: 'Output price / 1M', detail: price(d.outputPriceMicro) },
			{ term: 'Reasoning price / 1M', detail: price(d.reasoningPriceMicro) },
			{ term: 'Pricing rule', detail: d.pricingRuleId ?? '—' }
		]}
	/>
	<h3>Cost</h3>
	<Facts
		items={[
			{ term: 'Charged to customer', detail: cost(d.cost) },
			{ term: 'Credit charged', detail: cost(d.creditChargedMicro) },
			{ term: 'Provider cost', detail: cost(d.providerCostMicro) }
		]}
	/>
</Card>

<Card>
	<h2 class="first">Timing</h2>
	<Facts
		items={[
			{ term: 'TTFT', detail: ms(d.ttftMs) },
			{ term: 'Latency', detail: ms(d.latencyMs) },
			...data.timing.map((t: { key: string; ms: number | null }) => ({
				term: t.key,
				detail: ms(t.ms)
			}))
		]}
	/>
</Card>

<Card>
	<h2 class="first">Request/response content</h2>
	{#if !data.bodies.contentRetained}
		<Alert tone="info">Request/response content: not retained</Alert>
	{:else}
		<h3>Prompt</h3>
		{#if data.bodies.requestBody !== null}
			<pre class="body">{data.bodies.requestBody}</pre>
		{:else}
			<p class="muted">No request body captured.</p>
		{/if}
		<h3>Response</h3>
		{#if data.bodies.responseBody !== null}
			<pre class="body">{data.bodies.responseBody}</pre>
		{:else}
			<p class="muted">No response body captured.</p>
		{/if}
	{/if}
</Card>

<Card>
	<h2 class="first">Attempt timeline</h2>
	<TableWrap label="Attempts">
		<table class="fr">
			<thead>
				<tr>
					<th>#</th><th>Provider</th><th>Connection</th><th>Credential</th><th>HTTP</th>
					<th>Error code</th><th>Retryable</th><th>TTFT</th><th>Latency</th><th>Provider cost</th>
					<th>Reason</th><th>Started</th><th>Finished</th>
				</tr>
			</thead>
			<tbody>
				{#each data.attempts as a (a.id)}
					<tr>
						<td class="num">{a.attempt}</td>
						<td>{a.providerName ?? '—'}</td>
						<td>{a.connectionName ?? '—'}</td>
						<td><code>{a.credentialId ?? '—'}</code></td>
						<td class="num">{a.httpStatus ?? '—'}</td>
						<td><code>{a.errorCode ?? '—'}</code></td>
						<td>{a.retryable === null ? '—' : bool(a.retryable)}</td>
						<td class="num">{ms(a.ttftMs)}</td>
						<td class="num">{ms(a.latencyMs)}</td>
						<td class="num">{cost(a.providerCostMicro)}</td>
						<td>{a.reason ?? '—'}</td>
						<td class="num">{formatDateTime(a.startedAt)}</td>
						<td class="num">{a.finishedAt ? formatDateTime(a.finishedAt) : '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="13">No attempts recorded for this request.</td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>

<style>
	.body {
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--surface-2, rgba(127, 127, 127, 0.08));
		border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
		border-radius: 6px;
		padding: var(--space-sm, 0.5rem);
		max-height: 24rem;
		overflow: auto;
	}
</style>
