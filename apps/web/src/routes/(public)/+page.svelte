<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTokens } from '$lib/format';
	import { ButtonLink, Guide, Metric, VisualDivider } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';

	// Structured data for rich snippets — states only what the page states.
	const jsonLd = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'fudrouter',
		applicationCategory: 'DeveloperApplication',
		operatingSystem: 'Web',
		description:
			'One API key, every model. A commercial AI router with per-request metering, rate limits, and auditable usage.',
		url: 'https://ai.karepmuwes.my.id/',
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Pay per token' }
	});

	let { data } = $props();

	const metrics = $derived([
		{
			label: 'Models published',
			value: data.metrics.models === null ? '—' : formatTokens(data.metrics.models)
		},
		{
			label: 'Calls served',
			value: data.metrics.calls === null ? '—' : formatTokens(data.metrics.calls)
		},
		{
			label: 'Latency (24h)',
			value: data.metrics.latencyMs === null ? '—' : `${data.metrics.latencyMs.toLocaleString()}ms`
		}
	]);

	const features = [
		{ title: 'One endpoint', body: 'Point any [OI]-compatible client at one base URL.' },
		{ title: 'Metered per call', body: 'Tokens in, tokens out, cost and latency recorded.' },
		{ title: 'Audit to the token', body: 'Usage is your own log. Prompts are never stored.' }
	];

	const endpoints = [
		{ method: 'POST', path: '/v1/chat/completions', note: 'Chat, streaming or not' },
		{ method: 'GET', path: '/v1/models', note: 'Models this deployment exposes' },
		{ method: 'GET', path: '/health', note: 'Data-plane liveness' }
];
</script>

<svelte:head>
	{@html `<script type="application/ld+json">${jsonLd}</script>`}
</svelte:head>

<section class="hero">
	<p class="fr-label">Commercial AI router</p>
	<hr class="fr-rule" />
	<h1 class="display-xl">One API.<br />Every model.</h1>
	<p class="lede">
		Buy access once, spend it across every provider — metered per request,
		auditable to the token.
	</p>
	<div class="fr-actions">
		<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
		<ButtonLink href={resolve('/pricing')}>See pricing</ButtonLink>
	</div>
	<div class="fr-decorative-orb" aria-hidden="true">
		<FluidOrb size={320} color="#1A73F2" />
	</div>
</section>

<VisualDivider />

<section class="metrics-strip">
	{#each metrics as m (m.label)}
		<Metric label={m.label} value={m.value} />
	{/each}
</section>

<section class="features">
	{#each features as f (f.title)}
		<article>
			<hr class="fr-rule" />
			<h2>{f.title}</h2>
			<p class="muted">{f.body}</p>
		</article>
	{/each}
</section>

<Guide id="home" />

<section class="endpoints">
	<h2>Endpoints</h2>
	<div class="endpoint-grid">
		{#each endpoints as e (e.path)}
			<article class="endpoint-card">
				<span class="method fr-label">{e.method}</span>
				<code>{e.path}</code>
				<span class="muted">{e.note}</span>
			</article>
		{/each}
	</div>
	<p class="muted auth-note">Authenticate with <code>Authorization: Bearer sk-ar-…</code>. Mint a key from your dashboard.</p>
</section>

<VisualDivider />

<section class="closing">
	<h2>Start with one key.</h2>
	<p class="muted">Sign up, mint a key, and point a client at the API.</p>
	<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
</section>


