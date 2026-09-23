<script lang="ts">
	import { resolve } from '$app/paths';
	import { API_SURFACE_ORDER } from '$lib/catalog';
	import { formatTokens } from '$lib/format';
	import { ButtonLink, Guide, Metric, VisualDivider } from '$lib/ui';

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
			value: data.metrics.latencyMs === null ? '—' : `${data.metrics.latencyMs}ms`
		},
		{ label: 'Surfaces', value: String(API_SURFACE_ORDER.length) }
	]);

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
		fudrouter is a commercial AI router. Buy access once, spend it across every
		provider — with per-request metering and usage you can audit to the token.
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

<Guide id="home" />

<section class="endpoints">
	<h2>Endpoints</h2>
	<div class="table-wrap">
		<table class="fr">
			<tbody>
				{#each endpoints as e (e.path)}
					<tr><td class="method">{e.method}</td><td><code>{e.path}</code></td><td class="muted">{e.note}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="muted">Authenticate with <code>Authorization: Bearer sk-ar-…</code>. Mint a key from your dashboard.</p>
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
</style>
