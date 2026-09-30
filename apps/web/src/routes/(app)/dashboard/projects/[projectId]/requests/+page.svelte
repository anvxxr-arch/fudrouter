<script lang="ts">
	import { formatCost, formatDateTime, formatTokens } from '$lib/format';
	import {
		Badge,
		Button,
		ButtonLink,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		TableWrap,
		UxState
	} from '$lib/ui';
	import type { Tone } from '$lib/ui';
	let { data } = $props();
	// IP is a toggleable column (PRD §70 abuse signals read it, PRD §28 does not
	// list it): off by default so the common table stays narrow.
	let showIp = $state(false);
	const uxState = $derived(
		data.denied ? 'denied' : data.queryError ? 'error' : data.rows.length ? 'success' : 'empty'
	);
	const hasFilters = $derived(Object.keys(data.filters ?? {}).length > 0);
</script>

<PageHeader
	title="Request logs"
	lede={`Every call routed for ${data.projectName || 'this project'}, newest first.`}
/>
<Guide id="requests" />

<UxState
	state={uxState}
	emptyTitle={hasFilters ? 'No requests match these filters' : 'No requests yet'}
	emptyHint={hasFilters
		? 'Loosen a filter or clear the range to see the full log.'
		: 'Once this project routes a call, its log appears here.'}
	errorWhat={data.queryError ?? undefined}
	errorWhy="Reading the request ledger failed on the server."
>
	<form class="filters" method="GET">
		<Field label="From"><Input type="date" name="from" value={data.filters.from ?? ''} /></Field>
		<Field label="To"><Input type="date" name="to" value={data.filters.to ?? ''} /></Field>
		<Field label="Status">
			<Select name="status">
				<option value="">All</option>
				{#each data.statuses as s (s)}
					<option value={s} selected={data.filters.status === s}>{s}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Model">
			<Select name="model">
				<option value="">All</option>
				{#each data.options.models as m (m)}
					<option value={m} selected={data.filters.model === m}>{m}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Provider">
			<Select name="provider">
				<option value="">All</option>
				{#each data.options.providers as p (p.id)}
					<option value={p.id ?? ''} selected={data.filters.provider === p.id}>{p.name ?? p.id}</option>
				{/each}
			</Select>
		</Field>
		<Field label="API key">
			<Select name="key">
				<option value="">All</option>
				{#each data.options.keys as k (k.id)}
					<option value={k.id ?? ''} selected={data.filters.key === k.id}
						>{k.name ?? k.prefix ?? k.id}</option
					>
				{/each}
			</Select>
		</Field>
		<Field label="Environment">
			<Select name="env">
				<option value="">All</option>
				{#each data.options.environments as e (e.id)}
					<option value={e.id} selected={data.filters.env === e.id}>{e.name}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Endpoint">
			<Select name="endpoint">
				<option value="">All</option>
				{#each data.options.endpoints as ep (ep)}
					<option value={ep} selected={data.filters.endpoint === ep}>{ep}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Request ID" hint="The x-fudrouter-request-id value">
			<Input name="requestId" value={data.filters.requestId ?? ''} placeholder="req_…" />
		</Field>
		<Field label="Latency ≥ ms"><Input type="number" name="minLatency" min="0" value={data.filters.minLatency ?? ''} /></Field>
		<Field label="Latency ≤ ms"><Input type="number" name="maxLatency" min="0" value={data.filters.maxLatency ?? ''} /></Field>
		<Field label="Cost ≥ $"><Input name="minCost" inputmode="decimal" value={data.filters.minCost ?? ''} placeholder="0.00" /></Field>
		<Field label="Cost ≤ $"><Input name="maxCost" inputmode="decimal" value={data.filters.maxCost ?? ''} placeholder="0.00" /></Field>
		<div class="actions">
			<Button type="submit" variant="primary">Filter</Button>
			<ButtonLink href="/dashboard/projects/{data.projectId}/requests">Clear</ButtonLink>
		</div>
	</form>

	<label class="ip-toggle">
		<input type="checkbox" bind:checked={showIp} />
		Show client IP
	</label>

	<TableWrap label="Request log">
		<table class="fr">
			<thead>
				<tr>
					<th>Timestamp</th>
					<th>Status</th>
					<th>Model</th>
					<th>Provider</th>
					<th>Latency</th>
					<th>Tokens</th>
					<th>Cost</th>
					<th>API key</th>
					{#if showIp}<th>Client IP</th>{/if}
					<th>Request ID</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="num">{formatDateTime(r.createdAt)}</td>
						<td>
							<Badge tone={r.tone as Tone}>{r.status}</Badge>
							{#if r.storedStatus !== r.status}
								<span class="muted small">stored as {r.storedStatus}</span>
							{/if}
						</td>
						<td>{r.modelSlug ?? r.requestedModel ?? '—'}</td>
						<td>{r.providerName ?? '—'}</td>
						<td class="num">{r.latencyMs.toLocaleString()} ms</td>
						<td class="num">{formatTokens(r.totalTokens ?? r.tokensIn + r.tokensOut)}</td>
						<td class="num">{formatCost(BigInt(r.costMicro), r.currency)}</td>
						<td>{r.keyName ?? r.keyPrefix ?? '—'}</td>
						{#if showIp}<td class="num">{r.clientIp ?? '—'}</td>{/if}
						<td class="num">
							<a href="/dashboard/projects/{data.projectId}/requests/{r.id}">{r.id}</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>

	{#if data.nextHref}
		<nav class="pager" aria-label="Request log pages">
			<ButtonLink href={data.nextHref}>Older requests →</ButtonLink>
		</nav>
	{/if}
</UxState>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		align-items: flex-end;
		margin: var(--space-md) 0;
	}
	.filters :global(.field) {
		width: 9.5rem;
	}
	.actions {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}
	.ip-toggle {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
		margin-bottom: var(--space-sm);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.small {
		display: block;
		font-size: var(--text-xs);
	}
	.pager {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-md);
	}
</style>
