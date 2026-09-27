<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
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
	// The same helpers the tests cover, so "showed" means one thing everywhere.
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
</script>

<PageHeader
	title={data.provider.name}
	lede="{data.provider.baseUrl} — credentials, catalog and routing for this upstream."
/>

<p class="muted">
	<a href={resolve('/admin/providers')}>← All providers</a>
</p>

{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}

<!-- 1. Identity + 2. usage -->
<Card>
	<h2 class="first">Provider</h2>
	<Facts
		items={[
			{ term: 'Status', detail: data.provider.status },
			{ term: 'Base URL', detail: data.provider.baseUrl },
			{ term: 'Priority', detail: String(data.provider.priority) },
			{ term: 'Added', detail: data.provider.createdAt.slice(0, 10) },
			{
				term: 'Credentials',
				detail: data.credentials.error
					? data.credentials.error
					: `${data.credentials.count} (${data.credentials.kind})`
			},
			{
				term: 'Catalog',
				detail: `${data.models.length} models, ${data.published} published, ${data.reachable} reachable`
			}
		]}
	/>
</Card>

<Card>
	<h2 class="first">Statistik usage</h2>
	<div class="stats">
		<StatCard label="Requests" value={data.stats.totals.requests} />
		<StatCard
			label="Success"
			value={data.stats.totals.requests === 0
				? '—'
				: `${Math.round((data.stats.totals.ok / data.stats.totals.requests) * 100)}%`}
			tone={data.stats.totals.ok === data.stats.totals.requests ? 'success' : 'neutral'}
		/>
		<StatCard label="Avg latency" value={`${data.stats.totals.avgLatency} ms`} />
		<StatCard label="Max latency" value={`${data.stats.totals.maxLatency} ms`} />
		<StatCard label="Tokens in" value={data.stats.totals.tokensIn} />
		<StatCard label="Tokens out" value={data.stats.totals.tokensOut} />
		<StatCard label="Cost" value={`$${data.stats.totals.cost}`} />
		<StatCard label="Last 24h" value={data.stats.day.requests} />
	</div>

	{#if data.stats.perModel.length > 0}
		<h3>Per model</h3>
		<TableWrap label="Usage per model">
			<table class="fr">
				<thead>
					<tr><th>Model</th><th>Requests</th><th>Success</th><th>Avg latency</th></tr>
				</thead>
				<tbody>
					{#each data.stats.perModel as m (m.slug)}
						<tr>
							<td><code>{m.slug}</code></td>
							<td class="num">{m.requests}</td>
							<td class="num">{m.ok}</td>
							<td class="num">{m.avgLatency} ms</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{/if}

	{#if data.stats.recent.length > 0}
		<h3>Recent calls</h3>
		<TableWrap label="Recent calls">
			<table class="fr">
				<thead>
					<tr><th>When</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens</th></tr>
				</thead>
				<tbody>
					{#each data.stats.recent as r (r.createdAt + r.slug)}
						<tr>
							<td class="muted">{r.createdAt.slice(11, 19)}</td>
							<td><code>{r.slug}</code></td>
							<td>
								<Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
							</td>
							<td class="num">{r.latencyMs} ms</td>
							<td class="num">{r.tokensIn} / {r.tokensOut}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	{:else}
		<EmptyState title="No traffic recorded for this provider yet" />
	{/if}
</Card>

<!-- 3. quota -->
<Card>
	<h2 class="first">Quota</h2>
	{#if data.credentials.error}
		<Alert tone="warning">{data.credentials.error}</Alert>
	{:else}
		<Facts
			items={[
				{ term: 'Tracked balance', detail: 'Not reported by this provider.' },
				{
					term: 'Credential pool',
					detail: `${data.credentials.count} credential(s) — quota is per credential, and the router fails over between them.`
				},
				{
					term: 'How to see it',
					detail:
						'Run a credential test below: an upstream that reports a balance or quota returns it in that response.'
				}
			]}
		/>
	{/if}
</Card>

<!-- 4. rate limit -->
<Card>
	<h2 class="first">Rate limit</h2>
	{#if Object.keys(observedRateLimit).length > 0}
		<Facts items={Object.entries(observedRateLimit).map(([k, v]) => ({ term: k, detail: v }))} />
		<p class="muted">
			Observed on the last credential test. These are the upstream's own headers, not a router
			policy.
		</p>
	{:else}
		<Facts
			items={[
				{ term: 'Advertised', detail: 'No rate-limit headers seen yet.' },
				{
					term: 'How to see it',
					detail:
						'Run a credential test below; any x-ratelimit-* / retry-after headers are shown here.'
				}
			]}
		/>
	{/if}
</Card>

<VisualDivider />

<!-- 5. routing strategy -->
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

<VisualDivider />

<!-- 6. credentials -->
<Card>
	<h2 class="first">Credentials</h2>
	<p class="muted">
		{data.credentials.count} credential(s), auth kind
		<code>{data.credentials.kind}</code>{#if data.credentials.protocol}, native protocol <code
				>{data.credentials.protocol}</code
			>{/if}. Secrets are never sent to this page.
	</p>

	<form method="POST" action="?/testAll" use:enhance={track} class="inline-form">
		<Button type="submit" {pending} variant="primary">Test all credentials</Button>
	</form>
	{#if form?.bulkNote}<p class="muted">{form.bulkNote}</p>{/if}

	{#if form?.credentialTest}
		<div class="fr-feedback">
			<Alert tone={form.credentialTest.ok ? 'success' : 'danger'}>
				{form.credentialTest.label}: {form.credentialTest.ok
					? `HTTP ${form.credentialTest.status}, ${form.credentialTest.modelCount} models`
					: (form.credentialTest.error ?? `HTTP ${form.credentialTest.status}`)} ({form
					.credentialTest.latencyMs} ms)
			</Alert>
		</div>
	{/if}

	{#if form?.credentialTests}
		<TableWrap label="Credential test results">
			<table class="fr">
				<thead>
					<tr><th>Credential</th><th>Result</th><th>Models</th><th>Latency</th></tr>
				</thead>
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
			<thead>
				<tr><th>#</th><th>Credential</th><th>Test</th></tr>
			</thead>
			<tbody>
				{#each data.credentials.labels as c (c.index)}
					<tr>
						<td class="num">{c.index + 1}</td>
						<td>{c.label}</td>
						<td class="fr-actions">
							<form method="POST" action="?/testCredential" use:enhance={track} class="fr-inline">
								<input type="hidden" name="index" value={c.index} />
								<Button type="submit" {pending} aria-label="Test credential {c.label}">Test</Button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>

<VisualDivider />

<!-- 7. fetch models + gallery -->
<Card>
	<h2 class="first">Fetch models</h2>
	<p class="muted">
		Reads <code>{data.provider.baseUrl}/models</code> live. Nothing is written until you enable.
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
			<Button type="submit" {pending} variant="danger" formaction="?/disable">
				Disable showed
			</Button>
		</form>

		<div class="gallery">
			{#each shown ?? [] as m (m.slug)}
				<div class="model-card">
					<div class="head">
						<code class="slug">{m.slug}</code>
						<div class="badges">
							<Badge tone={tierTone[m.tier]}>{m.tier}</Badge>
							<Badge tone={m.state === 'active' ? 'success' : 'neutral'}
								>{stateLabel[m.state]}</Badge
							>
						</div>
					</div>
					<p class="muted small">
						{m.name !== m.slug ? m.name : '—'} · {m.context ?? '—'} ctx
					</p>
					<p class="muted small num">
						{m.inputUsd === null ? '—' : `$${m.inputUsd}`} in / {m.outputUsd === null
							? '—'
							: `$${m.outputUsd}`} out per 1M
					</p>
					<!-- Both hidden fields live in the row so the bulk form submits exactly
					     the cards the filter is showing. -->
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
					<tr
						><th>Slug</th><th>Context</th><th>In / 1M</th><th>Out / 1M</th><th>Status</th><th
							>Actions</th
						></tr
					>
				</thead>
				<tbody>
					{#each data.models as m (m.id)}
						<tr>
							<td><code>{m.slug}</code></td>
							<td class="num">{m.context ?? '—'}</td>
							<td class="num">${m.inputUsd}</td>
							<td class="num">${m.outputUsd}</td>
							<td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge></td
							>
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
											inputUsd: Number(m.inputUsd),
											outputUsd: Number(m.outputUsd)
										})}
									/>
									{#if m.status === 'active'}
										<Button
											type="submit"
											formaction="?/disable"
											{pending}
											aria-label="Disable model {m.slug}"
										>
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
						.tokensOut ?? '?'} out. {String(
						form.modelTest.content ?? form.modelTest.reasoning ?? ''
					).slice(0, 160)}
				{:else}
					— {form.modelTest.error ?? `HTTP ${form.modelTest.status}`}
				{/if}
			</Alert>
		</div>
	{/if}
</Card>

<VisualDivider />

<!-- 8. playground -->
<Card>
	<h2 class="first">Playground</h2>
	<p class="muted">
		Sends a real chat straight to the upstream with this provider's credential — no system prompt,
		no tools, and nothing recorded in the router's request log. Reasoning models can take up to a
		minute on a cold upstream.
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
							No answer text — the model spent the token budget on its own reasoning (finish reason <code
								>{form.chat.finishReason ?? '?'}</code
							>). Its trace:
						</Alert>
					</div>
					<pre class="reply">{form.chat.reasoning}</pre>
				{:else}
					<div class="fr-feedback">
						<Alert tone="warning">
							Empty reply (finish reason <code>{form.chat.finishReason ?? '?'}</code>).
						</Alert>
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
	/* Grid items default to min-width:auto, so a long unbreakable slug would
	   stretch the card past its track. */
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
