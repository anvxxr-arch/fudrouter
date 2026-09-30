<script lang="ts">
	import { formatCost, formatDateTime, formatTokens } from '$lib/format';
	import {
		Alert,
		ButtonLink,
		CodeBlock,
		Facts,
		Guide,
		PageHeader,
		Section,
		TableWrap,
		UxState
	} from '$lib/ui';
	let { data } = $props();
	const state = $derived(
		data.denied ? 'denied' : !data.row ? 'empty' : 'success'
	);
	const r = $derived(data.row);
</script>

<PageHeader title="Request detail" lede={r ? r.id : 'This request is not in this project.'} />
<Guide id="request-detail" />

<UxState
	{state}
	emptyTitle="Request not found"
	emptyHint="It may belong to another project, or the id is not a logged request. Check the request log for the current ids."
>
	{#if r}
		<Section title="Request metadata">
			<Facts
				items={[
					{ term: 'Request ID', detail: r.id },
					{ term: 'Timestamp', detail: `${formatDateTime(r.createdAt)} UTC` },
					{ term: 'Status', detail: r.status + (r.storedStatus !== r.status ? ` (stored as ${r.storedStatus})` : '') },
					{ term: 'Endpoint', detail: r.endpoint ?? '—' },
					{ term: 'Project', detail: r.projectName },
					{ term: 'Environment', detail: r.environmentName ?? '—' },
					{ term: 'API key', detail: r.keyName ?? r.keyPrefix ?? '—' },
					{ term: 'IP', detail: r.clientIp ?? 'Not recorded on this row' },
					{ term: 'Stream', detail: r.stream ? 'Yes' : 'No' },
					{ term: 'Client disconnected', detail: r.clientDisconnected ? 'Before completion' : 'No' }
				]}
			/>
		</Section>

		<Section title="Model information">
			<Facts
				items={[
					{ term: 'Requested model', detail: r.requestedModel ?? '—' },
					{ term: 'Resolved model', detail: r.resolvedSlug ?? '—' },
					{ term: 'Provider', detail: r.providerName ?? '—' },
					{ term: 'Provider model', detail: r.providerModelName ?? '—' },
					{ term: 'Connection', detail: r.connectionId ?? '—' },
					{ term: 'Strategy', detail: r.strategy ?? '—' },
					{ term: 'Routing policy', detail: r.routingPolicyId ?? '—' }
				]}
			/>
		</Section>

		<Section title="Usage">
			<Facts
				items={[
					{ term: 'Input tokens', detail: formatTokens(r.tokensIn) },
					{ term: 'Cached input tokens', detail: r.cachedInputTokens == null ? 'Not reported' : formatTokens(r.cachedInputTokens) },
					{ term: 'Output tokens', detail: formatTokens(r.tokensOut) },
					{ term: 'Reasoning tokens', detail: r.reasoningTokens == null ? 'Not reported' : formatTokens(r.reasoningTokens) },
					{ term: 'Total tokens', detail: formatTokens(r.totalTokens) }
				]}
			/>
		</Section>

		<Section title="Billing">
			<Facts
				items={[
					{ term: 'Provider cost', detail: r.providerCostMicro == null ? 'Not reported' : formatCost(BigInt(r.providerCostMicro), r.currency) },
					{ term: 'User cost', detail: formatCost(BigInt(r.costMicro), r.currency) },
					{ term: 'Markup', detail: r.markupMicro == null ? 'Unknown (provider cost missing)' : formatCost(BigInt(r.markupMicro), r.currency) },
					{ term: 'Credit charged', detail: r.creditChargedMicro == null ? 'Not charged to credits' : formatCost(BigInt(r.creditChargedMicro), r.currency) },
					{ term: 'Pricing rule', detail: r.pricingRuleId ?? '—' }
				]}
			/>
		</Section>

		<Section title="Timing" lede="Stage timings the router measured for this call.">
			<TableWrap label="Timing">
				<table class="fr">
					<thead><tr><th>Stage</th><th>Duration</th></tr></thead>
					<tbody>
						{#each data.timing as t (t.key)}
							<tr>
								<td>{t.key}</td>
								<td class="num">{t.ms == null ? '—' : `${t.ms.toLocaleString()} ms`}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		<Section title="Routing attempts" lede="Each candidate the router tried, in order.">
			<TableWrap label="Routing attempts">
				<table class="fr">
					<thead>
						<tr>
							<th>#</th><th>Provider</th><th>HTTP</th><th>Error</th><th>Retryable</th>
							<th>Latency</th><th>TTFT</th><th>Provider cost</th><th>Why this candidate</th>
						</tr>
					</thead>
					<tbody>
						{#each data.attempts as a (a.id)}
							<tr>
								<td class="num">{a.attempt}</td>
								<td>{a.providerName ?? '—'}</td>
								<td class="num">{a.httpStatus ?? '—'}</td>
								<td>{a.errorCode ?? '—'}</td>
								<td>{a.retryable == null ? '—' : a.retryable ? 'Yes' : 'No'}</td>
								<td class="num">{a.latencyMs.toLocaleString()} ms</td>
								<td class="num">{a.ttftMs == null ? '—' : `${a.ttftMs.toLocaleString()} ms`}</td>
								<td class="num"
									>{a.providerCostMicro == null
										? '—'
										: formatCost(BigInt(a.providerCostMicro), r.currency)}</td
								>
								<td>{a.reason ?? '—'}</td>
							</tr>
						{:else}
							<tr><td colspan="9">No attempt rows were recorded for this request.</td></tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>

		{#if r.error || r.errorCode || r.httpStatus}
			<Section title="Error">
				<Alert tone="danger">
					<strong>Normalized code:</strong>
					{r.errorCode ?? '—'}<br />
					<strong>HTTP status:</strong>
					{r.httpStatus ?? '—'}<br />
					<strong>Retryable:</strong>
					{r.retryable ? 'Yes' : 'No'}
					{#if r.error}<br /><strong>Upstream error:</strong> <code>{r.error}</code>{/if}
				</Alert>
			</Section>
		{/if}

		<Section title="Prompt and response" lede="Content retention decides whether bodies were kept.">
			{#if data.content?.state === 'shown'}
				<CodeBlock label="Request body" code={data.content.requestBody ?? ''} />
				<CodeBlock label="Response body" code={data.content.responseBody ?? ''} />
			{:else if data.content?.state === 'not_retained'}
				<Alert tone="info">
					<strong>Not retained.</strong> Retention policy does not keep prompt/response content for
					this row — metadata is always kept, content is opt-in (PRD §93–94).
				</Alert>
			{:else}
				<Alert tone="info">
					<strong>Not captured.</strong> No prompt/response bodies were stored for this request.
				</Alert>
			{/if}
		</Section>

		<p class="back">
			<ButtonLink href="/dashboard/projects/{data.projectId}/requests"
				>← Back to request logs</ButtonLink
			>
		</p>
	{/if}
</UxState>

<style>
	.back {
		margin-top: var(--space-lg);
	}
</style>
