<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTokens } from '$lib/format';
	import { ButtonLink, Guide, Metric, VisualDivider, TableWrap } from '$lib/ui';

	let { data } = $props();

	// The strip may only carry facts the server read from the database — a dash
	// is honest, an invented number is not.
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
		{
			title: 'One endpoint',
			body: 'Point any [OI]-compatible client at one base URL. The router holds the provider connections, so your code does not.'
		},
		{
			title: 'Metered per call',
			body: 'Tokens in, tokens out, cost and latency are recorded for every accepted call.'
		},
		{
			title: 'Audit to the token',
			body: 'Usage is your own log. Prompts and completions are never written to it.'
		}
	];

	const endpoints = [
		{ method: 'POST', path: '/v1/chat/completions', note: '[OI]-compatible chat, streaming or not' },
		{ method: 'GET', path: '/v1/models', note: 'models this deployment exposes' },
		{ method: 'GET', path: '/health', note: 'data-plane liveness' }
	];
</script>

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
	<TableWrap label="Endpoints">
		<table class="fr">
			<tbody>
				{#each endpoints as e (e.path)}
					<tr><td class="method">{e.method}</td><td><code>{e.path}</code></td><td class="muted">{e.note}</td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	<p class="muted">Authenticate with <code>Authorization: Bearer sk-ar-…</code>. Mint a key from your dashboard.</p>
</section>

<VisualDivider />

<!-- The closing CTA: DESIGN.md §Information Architecture gives the landing a
     feature grid *and* a CTA. Without it a reader who scrolls to the end gets a
     footer as their only prompt. -->
<section class="closing">
	<h2>Start with one key.</h2>
	<p class="muted">Sign up, mint a key, and point a client at the API.</p>
	<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
</section>

<style>
	.hero {
		position: relative;
		isolation: isolate;
		padding: var(--fr-space-2xl) 0 0;
	}
	/* The one gradient on a page (DESIGN.md §Colors): a soft brand glow behind
	   the headline. It never carries meaning and is not interactive. */
	.hero::before {
		content: '';
		position: absolute;
		inset: 0 0 20%;
		z-index: -1;
		pointer-events: none;
		background: var(--fr-glow);
	}
	.display-xl {
		max-width: 16ch;
		margin: 0;
		font-size: var(--fr-text-display-xl);
		font-weight: 700;
		line-height: var(--fr-display-xl-lh);
		letter-spacing: var(--fr-display-tracking);
	}
	.lede {
		max-width: 46ch;
		margin: 0;
		color: var(--fr-text-muted);
		font-size: var(--fr-text-lg);
		line-height: var(--fr-body-lh);
	}
	.fr-actions {
		display: flex;
		gap: var(--fr-space-sm);
		justify-content: flex-start;
	}
	/* The hairline above the strip is the VisualDivider, so the strip adds no
	   border of its own. */
	.metrics-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--fr-space-md);
		padding: 0 0 var(--fr-space-2xl);
	}
	/* Marketing grid. No card chrome: DESIGN.md keeps cards for forms and metrics,
	   so a feature is a rule + heading + line of copy. No border-top either — a
	   solid rule at a scene boundary is exactly what VisualDivider exists to avoid.
	   Bottom padding only, so the space above (from the metric strip) matches. */
	.features {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: var(--fr-space-xl);
		padding: 0 0 var(--fr-space-2xl);
	}
	.features h2 {
		margin: 0 0 var(--fr-space-xs);
		font-size: var(--fr-text-h5);
	}
	.features p {
		margin: 0;
		font-size: var(--fr-text-sm);
	}
	.closing {
		display: grid;
		justify-items: start;
		gap: var(--fr-space-sm);
		padding-bottom: var(--fr-space-2xl);
	}
	.closing h2 {
		margin: 0;
		font-size: var(--fr-text-h3);
	}
	.closing p {
		margin: 0;
	}
</style>
