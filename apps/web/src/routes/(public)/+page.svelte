<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatContext } from '$lib/public-format';
	import { BorderGlow, ButtonLink, Guide, Metric, VisualDivider } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { CODE_SAMPLE, FEATURE_SECTIONS, HERO_ACTIONS } from '$lib/guides/public-content';

	// Structured data for rich snippets — states only what the page states.
	const jsonLd = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'fudrouter',
		applicationCategory: 'DeveloperApplication',
		operatingSystem: 'Web',
		description:
			'Unified API for AI models. Connect once. Route anywhere. Metered per request, with per-request logs and auditable usage.',
		url: 'https://ai.karepmuwes.my.id/',
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Pay per token' }
	});
	let { data } = $props();
	const metrics = $derived([
		{
			label: 'Available models',
			value: data.metrics.models === null ? '—' : data.metrics.models.toLocaleString('en-US')
		},
		{
			label: 'Providers in network',
			value: data.metrics.providers === null ? '—' : String(data.metrics.providers)
		},
		{
			label: 'Calls served',
			value: data.metrics.calls === null ? '—' : data.metrics.calls.toLocaleString('en-US')
		},
		{
			label: 'Latency (24h)',
			value: data.metrics.latencyMs === null ? '—' : `${data.metrics.latencyMs.toLocaleString()}ms`
		}
	]);
</script>

<svelte:head>
	<!--
		`{@html}` is required: Svelte escapes text, and a JSON-LD block is a literal
		script element. The payload is JSON.stringify of the object literal above —
		no request data, no user input, nothing interpolated from a URL — so there is
		no XSS surface here. The string is also split so a closing script tag cannot
		appear in the source and terminate the parser's idea of the template early.
	-->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- see the note above -->
	{@html '<script type="application/ld+json">' + jsonLd + '</' + 'script>'}
</svelte:head>

<!-- PRD §13: the hero leads with the promise AND the OpenAI-compatible code
     sample is visible immediately — a developer landing shows the request, not
     a metaphor for one. -->
<section class="hero">
	<p class="fr-label">Commercial AI router</p>
	<hr class="fr-rule" />
	<h1 class="display-xl">
		Unified API for AI models.<br />Connect once. Route anywhere.
	</h1>
	<div class="hero-split">
		<div class="hero-copy">
			<p class="lede">
				One OpenAI-compatible key reaches every model and provider in the network — routed,
				metered and logged per request.
			</p>
			<div class="fr-actions">
				<ButtonLink variant="primary" href={resolve('/signup')}>{HERO_ACTIONS.primary}</ButtonLink>
				<!-- Plain href: /docs is served by the docs/[...slug] catch-all, which is
				     not its own RouteId, so typed resolve('/docs') cannot typecheck. -->
				<ButtonLink href="/models">{HERO_ACTIONS.secondary}</ButtonLink>
				<ButtonLink href="/docs">{HERO_ACTIONS.tertiary}</ButtonLink>
			</div>
		</div>
		<figure class="hero-code">
			<figcaption class="fr-label">{CODE_SAMPLE.label}</figcaption>
			<pre>{CODE_SAMPLE.code}</pre>
		</figure>
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
{#if data.sampleModels.length > 0}
	<section class="sample">
		<h2>Available models</h2>
		<p class="muted">A sample of the published catalog — the full table is on <a href={resolve('/models')}>Models</a>.</p>
		<div class="sample-grid">
			{#each data.sampleModels as m (m.slug)}
				<BorderGlow class="endpoint-card" radius="var(--radius-md)">
					<a class="sample-name" href="/models/{m.slug}">{m.name}</a>
					<code class="sample-slug">{m.slug}</code>
					<span class="muted num">{formatContext(m.context)} context</span>
				</BorderGlow>
			{/each}
		</div>
	</section>
{/if}
<Guide id="home" />
{#each FEATURE_SECTIONS as section (section.title)}
	<VisualDivider />
	<section class="feature">
		<h2>{section.title}</h2>
		<p class="muted">{section.body}</p>
		{#if section.href}
			<a href={section.href}>{section.linkLabel}</a>
		{/if}
	</section>
{/each}
<VisualDivider />
<section class="closing">
	<h2>Start with one key.</h2>
	<p class="muted">Sign up, mint a key, and point a client at the API.</p>
	<ButtonLink variant="primary" href={resolve('/signup')}>Get API Key</ButtonLink>
</section>

<style>
	.hero-split {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xl);
		align-items: flex-start;
		width: 100%;
	}
	.hero-copy {
		flex: 1 1 20rem;
		display: grid;
		gap: var(--space-md);
	}
	.hero-code {
		flex: 1 1 24rem;
		margin: 0;
		max-width: 34rem;
	}
	.hero-code pre {
		overflow-x: auto;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-md);
		font-size: var(--text-sm);
	}
	.metrics-strip {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-lg);
		padding: var(--space-lg);
	}
	.sample h2,
	.feature h2,
	.closing h2 {
		margin-bottom: var(--space-xs);
	}
	.sample-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--space-md);
		padding: var(--space-md) var(--space-lg);
	}
	.sample-name {
		font-weight: 600;
		color: var(--color-text);
		text-decoration: none;
	}
	.sample-slug {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}
	.feature {
		padding: var(--space-lg);
		max-width: 46rem;
	}
	.closing {
		padding: var(--space-2xl) var(--space-lg);
		display: grid;
		gap: var(--space-sm);
		justify-items: start;
	}
</style>
