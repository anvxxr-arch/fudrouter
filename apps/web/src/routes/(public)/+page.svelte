<script lang="ts">
	import { resolve } from '$app/paths';
	import { ButtonLink, Card } from '$lib/ui';

	const endpoints = [
		{
			method: 'POST',
			path: '/v1/chat/completions',
			note: '[OI]-compatible chat, streaming or not'
		},
		{ method: 'GET', path: '/v1/models', note: 'models this deployment exposes' },
		{ method: 'GET', path: '/health', note: 'data-plane liveness' }
	];
</script>

<section class="hero">
	<h1 class="display">One key. Every model.</h1>
	<p class="lede">
		fudrouter is a commercial AI router. Buy access once, spend it across every provider — with
		per-request metering, rate limits, and usage you can audit to the token.
	</p>
	<div class="fr-actions">
		<!-- One primary action only: the eye lands here first (Von Restorff). -->
		<ButtonLink variant="primary" href={resolve('/signup')}>Get started</ButtonLink>
		<ButtonLink href={resolve('/docs')}>Read the docs</ButtonLink>
	</div>
</section>

<section>
	<h2>Endpoints</h2>
	<Card>
		<div class="table-wrap">
<table class="fr">
			
				<tbody>
					{#each endpoints as e (e.path)}
						<tr>
							<td class="method">{e.method}</td>
							<td><code>{e.path}</code></td>
							<td class="muted">{e.note}</td>
						</tr>
					{/each}
				</tbody>
			</table></div>
	</Card>
	<p class="muted">
		Authenticate with <code>Authorization: Bearer sk-ar-…</code>. Mint a key from your dashboard.
	</p>
</section>

<style>
	.hero {
		padding: var(--fr-space-2xl) 0 var(--fr-space-xl);
	}
	.display {
		max-width: 20ch;
		margin: 0 0 var(--fr-space-md);
		font-size: var(--fr-text-display);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.15;
	}
	.lede {
		max-width: 52ch;
		margin: 0 0 var(--fr-space-lg);
		color: var(--fr-text-muted);
	}</style>
