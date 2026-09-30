<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		ButtonLink,
		Card,
		EmptyState,
		Facts,
		Field,
		Input,
		PageHeader,
		Guide,
		Select,
		StatCard,
		TableWrap,
		Textarea,
		VisualDivider
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatCost, formatTokens, formatDateTime } from '$lib/format';
	import { filterByTier, tierCounts, type UpstreamModel } from '$lib/provider-catalog';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	type Fetched = UpstreamModel & { state: 'active' | 'hidden' | 'new' };
	// The fetched catalog is kept locally so it survives the follow-up
	// enable/disable POSTs (an action result replaces `form`, and the gallery
	// would otherwise vanish the moment you act on it).
	let gallery = $state<Fetched[] | null>(null);
	let galleryMeta = $state<{ url: string; latencyMs: number; total: number } | null>(null);
	let tierFilter = $state<'all' | 'free' | 'paid' | 'unknown'>('all');
	$effect(() => {
		const fetched = form?.fetched;
		if (fetched) {
			gallery = fetched.models as Fetched[];
			galleryMeta = { url: fetched.url, latencyMs: fetched.latencyMs, total: fetched.total };
		}
	});
	// Filtering removes cards from the DOM on purpose: the enable/disable buttons
	// submit the rendered form, so "showed" and "submitted" must be the same set.
	const shown = $derived(gallery === null ? null : filterByTier(gallery, tierFilter));
	const shownCounts = $derived(tierCounts(gallery ?? []));
	let chatModel = $state('');
	$effect(() => {
		if (!chatModel && data.models.length > 0) chatModel = data.models[0].slug;
	});
	const observedRateLimit = $derived.by(() => {
		const seen: Record<string, string> = {};
		if (form?.credentialTest) Object.assign(seen, form.credentialTest.rateLimit);
		for (const t of form?.credentialTests ?? []) Object.assign(seen, t.rateLimit);
		return seen;
	});
	const tierTone: Record<string, 'success' | 'info' | 'neutral'> = {
		free: 'success',
		paid: 'info',
		unknown: 'neutral'
	};
	const stateLabel: Record<string, string> = {
		active: 'in catalog',
		hidden: 'hidden',
		new: 'not seeded'
	};
	// Tab strip: plain toggles between sections of this one page. Connections and
	// Credentials are real routes of their own and are linked to from their tabs.
	const TABS = [
		['overview', 'Overview'],
		['connections', 'Connections'],
		['credentials', 'Credentials'],
		['models', 'Models'],
		['pricing', 'Pricing'],
		['limits', 'Limits'],
		['health', 'Health'],
		['errors', 'Errors'],
		['logs', 'Logs']
	] as const;
	let tab = $state<(typeof TABS)[number][0]>('overview');
	const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
	/**
	 * micro-units as digits → the USD-per-1M decimal the enable payload carries.
	 * Integer string arithmetic: a price never becomes a float on the way out.
	 */
	function usdInput(micro: string): string {
		const digits = micro.replace(/[^0-9]/g, '') || '0';
		const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '') || '0';
		const frac = digits.slice(-6).replace(/0+$/, '');
		return frac ? `${whole}.${frac}` : whole;
	}
	const healthTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		healthy: 'success',
		degraded: 'warning',
		unhealthy: 'danger',
		unknown: 'neutral'
	};
</script>

<PageHeader
	title={data.provider.name}
	lede="{data.provider.baseUrl || 'no endpoint yet'} — connections, credentials, catalog and observed health."
/>
<p class="muted">
	<a href={resolve('/admin/providers')}>← All providers</a>
</p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}

<nav class="tabs" aria-label="Provider sections">
	{#each TABS as [key, label] (key)}
		<button
			type="button"
			class:active={tab === key}
			aria-current={tab === key ? 'true' : undefined}
			onclick={() => (tab = key)}>{label}</button
		>
	{/each}
</nav>

<!-- Overview -->
{#if tab === 'overview'}
	<Card>
		<h2 class="first">Provider</h2>
		<Facts
			items={[
				{ term: 'Slug', detail: data.provider.slug ?? '—' },
				{ term: 'Type', detail: data.provider.type ?? '—' },
				{ term: 'Status', detail: data.provider.status },
				{ term: 'Tier', detail: data.provider.tier },
				{ term: 'Enabled', detail: data.provider.enabled ? 'yes' : 'no' },
				{ term: 'Homepage', detail: data.provider.homepage ?? '—' },
				{ term: 'Docs', detail: data.provider.documentationUrl ?? '—' },
				{ term: 'Description', detail: data.provider.description ?? '—' },
				{ term: 'Base URL', detail: data.provider.baseUrl || '—' },
				{ term: 'Priority', detail: String(data.provider.priority) },
				{ term: 'Added', detail: data.provider.createdAt.slice(0, 10) },
				{
					term: 'Catalog',
					detail: `${data.models.length} models, ${data.published} published, ${data.reachable} reachable`
				},
				{
					term: 'Credentials',
					detail: `${data.credentials.healthy} healthy / ${data.credentials.count} total`
				}
			]}
		/>
	</Card>
	<Card>
		<h2 class="first">At a glance</h2>
		<div class="stats">
			<StatCard label="Requests" value={data.stats.totals.requests} />
			<StatCard
				label="Success"
				value={pct(data.stats.totals.ok, data.stats.totals.requests)}
				tone={data.stats.totals.ok === data.stats.totals.requests ? 'success' : 'neutral'}
			/>
			<StatCard label="P50" value={`${data.stats.totals.p50} ms`} />
			<StatCard label="P95" value={`${data.stats.totals.p95} ms`} />
			<StatCard label="P99" value={`${data.stats.totals.p99} ms`} />
			<StatCard
				label="429 rate"
				value={pct(data.stats.totals.rate429, data.stats.totals.requests)}
				tone={data.stats.totals.rate429 > 0 ? 'warning' : 'neutral'}
			/>
			<StatCard
				label="5xx rate"
				value={pct(data.stats.totals.rate5xx, data.stats.totals.requests)}
				tone={data.stats.totals.rate5xx > 0 ? 'danger' : 'neutral'}
			/>
			<StatCard label="Cost" value={formatCost(BigInt(data.stats.totals.costMicro))} />
		</div>
	</Card>
	<Card>
		<h2 class="first">Strategy routing</h2>
		<Facts
			items={[
				{
					term: 'Model → provider',
					detail:
						'model.slug is unique table-wide, so a slug maps to exactly one provider. Nothing is load-balanced across providers.'
				},
				{
					term: 'Credential choice',
					detail: `Round-robin across this provider's ${data.credentials.count} credential(s); a failed one is parked for 5 minutes.`
				},
				{
					term: 'Failover',
					detail: 'Up to 3 credentials are tried within one request before the call fails.'
				},
				{
					term: 'Dev gate',
					detail: data.allowDev
						? "Dev providers are ON (ROUTER_ALLOW_DEV_PROVIDERS) — a 'dev' provider serves."
						: "Dev providers are OFF — a 'dev' provider is hidden however it is published."
				},
				{
					term: 'Priority',
					detail:
						'Stored and shown. The selector does not order by it today — do not assume a lower number wins a call.'
				}
			]}
		/>
		<form method="POST" action="?/strategy" use:enhance={track} class="inline-form">
			<Field label="Priority">
				<Input name="priority" type="number" value={data.provider.priority} />
			</Field>
			<div class="submit"><Button type="submit" {pending} variant="primary">Save</Button></div>
		</form>
	</Card>
{/if}

<!-- Connections tab → the sub-route -->
{#if tab === 'connections'}
	<Card>
		<h2 class="first">Connections</h2>
		<p class="muted">
			{data.connections.length} connection(s). Endpoints, auth shape and per-connection credentials
			are edited on the connections page.
		</p>
		<div class="inline-form">
			<ButtonLink
				href={resolve('/admin/providers/[id]/connections', { id: data.provider.id })}
				variant="primary">Manage connections</ButtonLink
			>
		</div>
		<TableWrap label="Connections summary">
			<table class="fr">
				<thead><tr><th>Name</th><th>Base URL</th><th>Auth</th><th>Health</th></tr></thead>
				<tbody>
					{#each data.connections as c (c.id)}
						<tr>
							<td>{c.name}</td>
							<td><code>{c.baseUrl}</code></td>
							<td>{c.authType}</td>
							<td><Badge tone={healthTone[c.healthStatus] ?? 'neutral'}>{c.healthStatus}</Badge></td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No connections yet" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
{/if}

<!-- Credentials tab → the sub-route, plus the live probes that live here -->
{#if tab === 'credentials'}
	<Card>
		<h2 class="first">Credentials</h2>
		<p class="muted">
			{data.credentials.count} credential(s) — {data.credentials.healthy} healthy,
			{data.credentials.cooldown} cooling down, {data.credentials.bad} bad, {data.credentials.unknown}
			unproven. Secrets are never sent to this page.
		</p>
		<div class="inline-form">
			<ButtonLink
				href={resolve('/admin/providers/[id]/credentials', { id: data.provider.id })}
				variant="primary">Manage the credential pool</ButtonLink
			>
			<form method="POST" action="?/testAll" use:enhance={track} class="fr-inline">
				<Button type="submit" {pending}>Test all credentials</Button>
			</form>
		</div>
		{#if form?.bulkNote}<p class="muted">{form.bulkNote}</p>{/if}
		{#if form?.credentialTest}
			<div class="fr-feedback">
				<Alert tone={form.credentialTest.ok ? 'success' : 'danger'}>
					{form.credentialTest.label}: {form.credentialTest.ok
						? `HTTP ${form.credentialTest.status}, ${form.credentialTest.modelCount} models`
						: (form.credentialTest.error ?? `HTTP ${form.credentialTest.status}`)} ({form.credentialTest
						.latencyMs} ms)
				</Alert>
			</div>
		{/if}
		{#if form?.credentialTests}
			<TableWrap label="Credential test results">
				<table class="fr">
					<thead><tr><th>Credential</th><th>Result</th><th>Models</th><th>Latency</th></tr></thead>
					<tbody>
						{#each form.credentialTests as t (t.index)}
							<tr>
								<td>{t.label}</td>
								<td>
									{#if t.ok}
										<Badge tone="success">HTTP {t.status}</Badge>
									{:else}
										<Badge tone="danger">{t.error ?? `HTTP ${t.status}`}</Badge>
									{/if}
								</td>
								<td class="num">{t.modelCount}</td>
								<td class="num">{t.latencyMs} ms</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{/if}
		<TableWrap label="Credential list">
			<table class="fr">
				<thead><tr><th>#</th><th>Credential</th><th>Connection</th><th>Status</th><th>Test</th></tr></thead>
				<tbody>
					{#each data.credentials.labels as c (c.index)}
						<tr>
							<td class="num">{c.index + 1}</td>
							<td>{c.label}</td>
							<td>{c.connection}</td>
							<td><Badge tone="neutral">{c.status}</Badge></td>
							<td class="fr-actions">
								<form method="POST" action="?/testCredential" use:enhance={track} class="fr-inline">
									<input type="hidden" name="index" value={c.index} />
									<Button type="submit" {pending} aria-label="Test credential {c.label}">Test</Button>
								</form>
							</td>
						</tr>
					{:else}
						<tr><td colspan="5"><EmptyState title="No credentials yet" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		{#if Object.keys(observedRateLimit).length > 0}
			<h3>Observed rate limits</h3>
			<Facts items={Object.entries(observedRateLimit).map(([k, v]) => ({ term: k, detail: v }))} />
			<p class="muted">Upstream headers from the last probe — not a router policy.</p>
		{/if}
	</Card>
{/if}

<!-- Models tab: seeded catalog + the fetch/enable flow -->
{#if tab === 'models'}
	<Card>
		<h2 class="first">Fetch models</h2>
		<p class="muted">
			Reads <code>{data.provider.baseUrl || 'the first connection base URL'}/models</code> live.
			Nothing is written until you enable.
		</p>
		<form method="POST" action="?/fetchCatalog" use:enhance={track} class="inline-form">
			<div class="submit">
				<Button type="submit" {pending} variant="primary">Fetch catalog</Button>
			</div>
		</form>
		{#if galleryMeta}
			<p class="muted">
				{galleryMeta.total} models from <code>{galleryMeta.url}</code> in {galleryMeta.latencyMs} ms.
				{gallery?.length ?? 0} seeded.
			</p>
		{/if}
		{#if gallery}
			<div class="tier-filter">
				<Button
					type="button"
					variant={tierFilter === 'all' ? 'primary' : 'secondary'}
					onclick={() => (tierFilter = 'all')}
				>
					All ({gallery.length})
				</Button>
				<Button
					type="button"
					variant={tierFilter === 'free' ? 'primary' : 'secondary'}
					onclick={() => (tierFilter = 'free')}
				>
					Free only ({shownCounts.free})
				</Button>
				<Button
					type="button"
					variant={tierFilter === 'paid' ? 'primary' : 'secondary'}
					onclick={() => (tierFilter = 'paid')}
				>
					Paid only ({shownCounts.paid})
				</Button>
				{#if shownCounts.unknown > 0}
					<Button
						type="button"
						variant={tierFilter === 'unknown' ? 'primary' : 'secondary'}
						onclick={() => (tierFilter = 'unknown')}
					>
						No price ({shownCounts.unknown})
					</Button>
				{/if}
			</div>
			<form method="POST" use:enhance={track} class="bulk">
				<span class="muted">{shown?.length ?? 0} shown</span>
				<Button type="submit" {pending} variant="primary" formaction="?/enable">Enable showed</Button>
				<Button type="submit" {pending} variant="danger" formaction="?/disable">Disable showed</Button>
			</form>
			<div class="gallery">
				{#each shown ?? [] as m (m.slug)}
					<div class="model-card">
						<div class="head">
							<code class="slug">{m.slug}</code>
							<div class="badges">
								<Badge tone={tierTone[m.tier]}>{m.tier}</Badge>
								<Badge tone={m.state === 'active' ? 'success' : 'neutral'}>{stateLabel[m.state]}</Badge>
							</div>
						</div>
						<p class="muted small">{m.name !== m.slug ? m.name : '—'} · {m.context ?? '—'} ctx</p>
						<p class="muted small num">
							{m.inputUsd === null ? '—' : `$${m.inputUsd}`} in / {m.outputUsd === null
								? '—'
								: `$${m.outputUsd}`} out per 1M
						</p>
						<input
							type="hidden"
							name="payload"
							value={JSON.stringify({
								slug: m.slug,
								name: m.name,
								context: m.context,
								inputUsd: m.inputUsd ?? 0,
								outputUsd: m.outputUsd ?? 0
							})}
						/>
						<input type="hidden" name="slug" value={m.slug} />
					</div>
				{/each}
			</div>
			{#if (shown?.length ?? 0) === 0}
				<EmptyState title="No models match this filter" />
			{/if}
		{:else}
			<EmptyState title="Fetch the catalog to compare it against what is seeded" />
		{/if}
	</Card>
	<Card>
		<h2 class="first">Catalog</h2>
		<p class="muted">
			Seeded for this provider: {data.models.length} ({data.published} published, {data.reachable}
			reachable).
		</p>
		{#if data.models.length > 0}
			<TableWrap label="Seeded models">
				<table class="fr">
					<thead>
						<tr>
							<th>Slug</th><th>Context</th><th>In / 1M</th><th>Out / 1M</th><th>Status</th><th
								>Actions</th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.models as m (m.id)}
							<tr>
								<td><code>{m.slug}</code></td>
								<td class="num">{m.context ?? '—'}</td>
								<td class="num">{formatCost(BigInt(m.inputMicro))}</td>
								<td class="num">{formatCost(BigInt(m.outputMicro))}</td>
								<td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge></td>
								<td class="fr-actions">
									<form method="POST" use:enhance={track} class="fr-inline">
										<input type="hidden" name="slug" value={m.slug} />
										<input
											type="hidden"
											name="payload"
											value={JSON.stringify({
												slug: m.slug,
												name: m.name,
												context: m.context,
												inputUsd: usdInput(m.inputMicro),
												outputUsd: usdInput(m.outputMicro)
											})}
										/>
										{#if m.status === 'active'}
											<Button type="submit" formaction="?/disable" {pending} aria-label="Disable model {m.slug}">
												Disable
											</Button>
										{:else}
											<Button
												type="submit"
												formaction="?/enable"
												{pending}
												variant="primary"
												aria-label="Enable model {m.slug}"
											>
												Enable
											</Button>
										{/if}
									</form>
									<form method="POST" action="?/testModel" use:enhance={track} class="fr-inline">
										<input type="hidden" name="slug" value={m.slug} />
										<Button type="submit" {pending} aria-label="Test model {m.slug}">Test</Button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="Nothing seeded for this provider" />
		{/if}
		{#if form?.modelTest}
			<div class="fr-feedback">
				<Alert tone={form.modelTest.ok ? 'success' : 'danger'}>
					<strong>{form.modelTest.slug}</strong>
					{#if form.modelTest.ok}
						— {form.modelTest.latencyMs} ms, {form.modelTest.tokensIn ?? '?'} in / {form.modelTest
							.tokensOut ?? '?'} out. {String(form.modelTest.content ?? form.modelTest.reasoning ?? '').slice(0, 160)}
					{:else}
						— {form.modelTest.error ?? `HTTP ${form.modelTest.status}`}
					{/if}
				</Alert>
			</div>
		{/if}
		{#if data.mappings.length > 0}
			<h3>Provider mappings</h3>
			<TableWrap label="Provider model mappings">
				<table class="fr">
					<thead>
						<tr><th>Model</th><th>Upstream id</th><th>Connection</th><th>Enabled</th><th>Status</th></tr>
					</thead>
					<tbody>
						{#each data.mappings as pm (pm.id)}
							<tr>
								<td><code>{pm.modelSlug}</code></td>
								<td><code>{pm.providerModelId}</code></td>
								<td>{pm.connectionId ?? 'any'}</td>
								<td>{pm.enabled ? 'yes' : 'no'}</td>
								<td>{pm.status}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{/if}
	</Card>
	<Card>
		<h2 class="first">Playground</h2>
		<p class="muted">
			Sends a real chat straight to the upstream with this provider's first credential — no system
			prompt, no tools, and nothing recorded in the router's request log.
		</p>
		<form method="POST" action="?/chat" use:enhance={track}>
			<Field label="Model">
				<Select
					name="slug"
					value={chatModel}
					onchange={(e: Event) => (chatModel = (e.currentTarget as HTMLSelectElement).value)}
				>
					{#each data.models as m (m.id)}
						<option value={m.slug}>{m.slug}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Message">
				<Textarea name="message" rows="4" placeholder="Say hello in one short sentence."></Textarea>
			</Field>
			<div class="submit">
				<Button type="submit" {pending} variant="primary" disabled={data.models.length === 0}>
					Send
				</Button>
			</div>
		</form>
		{#if data.models.length === 0}
			<EmptyState title="Seed a model before using the playground" />
		{/if}
		{#if form?.chat}
			<div class="chat-result">
				<div class="stats">
					<StatCard label="Latency" value={`${form.chat.latencyMs} ms`} />
					<StatCard label="Tokens in" value={form.chat.tokensIn ?? '—'} />
					<StatCard label="Tokens out" value={form.chat.tokensOut ?? '—'} />
					<StatCard
						label="Result"
						value={form.chat.ok ? `HTTP ${form.chat.status}` : 'failed'}
						tone={form.chat.ok ? 'success' : 'danger'}
					/>
				</div>
				{#if form.chat.ok}
					<h3>Reply</h3>
					{#if form.chat.content}
						<pre class="reply">{form.chat.content}</pre>
					{:else if form.chat.reasoning}
						<div class="fr-feedback">
							<Alert tone="warning">
								No answer text — the model spent the token budget on its own reasoning (finish reason
								<code>{form.chat.finishReason ?? '?'}</code>). Its trace:
							</Alert>
						</div>
						<pre class="reply">{form.chat.reasoning}</pre>
					{:else}
						<div class="fr-feedback">
							<Alert tone="warning">Empty reply (finish reason <code>{form.chat.finishReason ?? '?'}</code>).</Alert>
						</div>
					{/if}
				{:else}
					<div class="fr-feedback">
						<Alert tone="danger">{form.chat.error ?? 'request failed'}</Alert>
					</div>
				{/if}
			</div>
		{/if}
	</Card>
{/if}

<!-- Pricing -->
{#if tab === 'pricing'}
	<Card>
		<h2 class="first">Pricing</h2>
		<p class="muted">
			Immutable versioned rules — a price change is a new row. Values are micro-units of currency per
			1M tokens.
		</p>
		{#if data.pricing.length > 0}
			<TableWrap label="Pricing rules">
				<table class="fr">
					<thead>
						<tr>
							<th>Model</th><th>Version</th><th>Input</th><th>Cached in</th><th>Out</th>
							<th>Reasoning</th><th>From</th><th>Until</th>
						</tr>
					</thead>
					<tbody>
						{#each data.pricing as r (r.id)}
							<tr>
								<td><code>{r.modelSlug}</code></td>
								<td class="num">v{r.version}</td>
								<td class="num">{formatCost(BigInt(r.inputMicro), r.currency)}</td>
								<td class="num"
									>{r.cachedInputMicro === null ? '—' : formatCost(BigInt(r.cachedInputMicro), r.currency)}</td
								>
								<td class="num">{formatCost(BigInt(r.outputMicro), r.currency)}</td>
								<td class="num"
									>{r.reasoningMicro === null ? '—' : formatCost(BigInt(r.reasoningMicro), r.currency)}</td
								>
								<td class="num">{formatDateTime(r.effectiveFrom)}</td>
								<td class="num"
									>{r.effectiveUntil ? formatDateTime(r.effectiveUntil) : 'current'}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No pricing rules yet" hint="Seed a model with prices to create version 1." />
		{/if}
	</Card>
{/if}

<!-- Limits -->
{#if tab === 'limits'}
	<Card>
		<h2 class="first">Limits</h2>
		<p class="muted">Rate limits and circuit breakers scoped to this provider.</p>
		<h3>Rate limits</h3>
		{#if data.limits.length > 0}
			<TableWrap label="Rate limits">
				<table class="fr">
					<thead>
						<tr><th>Scope</th><th>RPM</th><th>TPM</th><th>RPD</th><th>TPD</th><th>Concurrency</th></tr>
					</thead>
					<tbody>
						{#each data.limits as l (l.id)}
							<tr>
								<td>{l.scope}: <code>{l.scopeId}</code></td>
								<td class="num">{l.rpm ?? '—'}</td>
								<td class="num">{l.tpm ?? '—'}</td>
								<td class="num">{l.rpd ?? '—'}</td>
								<td class="num">{l.tpd ?? '—'}</td>
								<td class="num">{l.concurrency ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No rate limit scoped to this provider" />
		{/if}
		<h3>Circuit breakers</h3>
		{#if data.breakers.length > 0}
			<TableWrap label="Circuit breakers">
				<table class="fr">
					<thead>
						<tr>
							<th>Target</th><th>Failures</th><th>Window</th><th>Open for</th><th>Probes</th><th
								>Enabled</th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.breakers as b (b.id)}
							<tr>
								<td>{b.target}: <code>{b.targetId}</code></td>
								<td class="num">{b.failureThreshold}</td>
								<td class="num">{b.windowSeconds} s</td>
								<td class="num">{b.openMs} ms</td>
								<td class="num">{b.halfOpenProbes}</td>
								<td>{b.enabled ? 'yes' : 'no'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No circuit breaker scoped to this provider" />
		{/if}
	</Card>
{/if}

<!-- Health -->
{#if tab === 'health'}
	<Card>
		<h2 class="first">Health</h2>
		<div class="stats">
			<StatCard label="Requests (24h)" value={data.stats.day.requests} />
			<StatCard label="Success (24h)" value={pct(data.stats.day.ok, data.stats.day.requests)} />
			<StatCard label="P50 (24h)" value={`${data.stats.day.p50} ms`} />
			<StatCard label="P95 (24h)" value={`${data.stats.day.p95} ms`} />
			<StatCard label="P99 (24h)" value={`${data.stats.day.p99} ms`} />
			<StatCard label="429 (24h)" value={data.stats.day.rate429} />
			<StatCard label="5xx (24h)" value={data.stats.day.rate5xx} />
			<StatCard
				label="Credentials"
				value={`${data.credentials.healthy}/${data.credentials.count} healthy`}
				tone={data.credentials.healthy === data.credentials.count ? 'success' : 'warning'}
			/>
		</div>
		<h3>Connections</h3>
		<TableWrap label="Connection health">
			<table class="fr">
				<thead><tr><th>Name</th><th>Base URL</th><th>Health</th><th>Enabled</th></tr></thead>
				<tbody>
					{#each data.connections as c (c.id)}
						<tr>
							<td>{c.name}</td>
							<td><code>{c.baseUrl}</code></td>
							<td><Badge tone={healthTone[c.healthStatus] ?? 'neutral'}>{c.healthStatus}</Badge></td>
							<td>{c.enabled ? 'yes' : 'no'}</td>
						</tr>
					{:else}
						<tr><td colspan="4"><EmptyState title="No connections yet" /></td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Card>
{/if}

<!-- Errors -->
{#if tab === 'errors'}
	<Card>
		<h2 class="first">Errors</h2>
		{#if data.stats.errors.length > 0}
			<TableWrap label="Errors by code">
				<table class="fr">
					<thead>
						<tr><th>Error code</th><th>HTTP</th><th>Message</th><th>Count</th><th>Last seen</th></tr>
					</thead>
					<tbody>
						{#each data.stats.errors as e (String(e.errorCode) + String(e.httpStatus) + String(e.error))}
							<tr>
								<td><code>{e.errorCode ?? '—'}</code></td>
								<td class="num">{e.httpStatus ?? '—'}</td>
								<td>{e.error ?? '—'}</td>
								<td class="num">{e.n}</td>
								<td class="num">{e.lastAt ? e.lastAt.replace('T', ' ').slice(0, 19) : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No errors recorded for this provider" />
		{/if}
	</Card>
{/if}

<!-- Logs -->
{#if tab === 'logs'}
	<Card>
		<h2 class="first">Logs</h2>
		<p class="muted">Per-model aggregates and the last 20 calls.</p>
		{#if data.stats.perModel.length > 0}
			<h3>Per model</h3>
			<TableWrap label="Usage per model">
				<table class="fr">
					<thead>
						<tr><th>Model</th><th>Requests</th><th>Success</th><th>P50</th><th>P95</th></tr>
					</thead>
					<tbody>
						{#each data.stats.perModel as m (m.slug)}
							<tr>
								<td><code>{m.slug}</code></td>
								<td class="num">{m.requests}</td>
								<td class="num">{pct(m.ok, m.requests)}</td>
								<td class="num">{m.p50} ms</td>
								<td class="num">{m.p95} ms</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{/if}
		<h3>Recent calls</h3>
		{#if data.stats.recent.length > 0}
			<TableWrap label="Recent calls">
				<table class="fr">
					<thead>
						<tr>
							<th>When</th><th>Model</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Tokens</th>
						</tr>
					</thead>
					<tbody>
						{#each data.stats.recent as r (r.createdAt + r.slug)}
							<tr>
								<td class="muted">{r.createdAt.slice(11, 19)}</td>
								<td><code>{r.slug}</code></td>
								<td>
									<Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
								</td>
								<td class="num">{r.httpStatus ?? '—'}</td>
								<td class="num">{r.latencyMs} ms</td>
								<td class="num">{formatTokens(r.tokensIn)} / {formatTokens(r.tokensOut)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		{:else}
			<EmptyState title="No traffic recorded for this provider yet" />
		{/if}
	</Card>
{/if}

<VisualDivider />
<Guide id="admin-providers" />

<style>
	h2.first {
		margin-top: 0;
	}
	h3 {
		margin-top: var(--space-lg);
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
	.inline-form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		align-items: end;
		margin-block: var(--space-md);
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--space-md);
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin: var(--space-md) 0;
	}
	.tabs button {
		padding: var(--space-xs) var(--space-sm);
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		cursor: pointer;
	}
	.tabs button.active {
		background: var(--color-surface-raised);
		color: var(--color-text);
		border-color: var(--primary);
	}
	.tier-filter,
	.bulk {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: center;
		margin-block: var(--space-md);
	}
	.bulk .muted {
		margin-right: auto;
	}
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--space-md);
	}
	.model-card {
		min-width: 0;
		display: grid;
		gap: var(--space-xs);
		align-content: start;
		padding: var(--space-card);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}
	.model-card .head {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: flex-start;
		justify-content: space-between;
		min-width: 0;
	}
	.slug {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.badges {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.small {
		font-size: var(--text-sm);
	}
	.reply {
		margin: 0;
		padding: var(--space-card);
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.chat-result {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-lg);
	}
</style>
