<script lang="ts">
	import { page } from '$app/state';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { NavProgress } from '$lib/ui';
	import { titleFor } from '$lib/titles';

	let { children } = $props();

	// An error page is named by its status; every other page by its own name.
	const title = $derived(
		page.status >= 400 ? `${page.status} — fudrouter` : titleFor(page.url.pathname)
	);

	// Canonical URL strips query/hash and pins the public origin, so any mirror
	// or staging host that proxies this app cannot split search equity.
	const canonical = $derived(
		`https://ai.karepmuwes.my.id${page.url.pathname === '/' ? '/' : page.url.pathname}`
	);
	// One description per section — same resolution rule as the title map.
	const DESCRIPTIONS: Record<string, string> = {
		'/': 'One API key, every model. A commercial AI router with per-request metering, rate limits, and auditable usage.',
		'/pricing':
			'Pay per token — no seat fees. Per-model input and output prices across every provider.',
		'/models': 'Every model this deployment serves, with context windows and tier badges.',
		'/docs': 'API reference: auth, catalog, chat completions, and health endpoints.',
		'/status': 'Live data-plane status and recent incidents.',
		'/legal/terms': 'Terms of Service for fudrouter.',
		'/legal/privacy': 'Privacy Policy for fudrouter.'
	};
	const description = $derived(DESCRIPTIONS[page.url.pathname] ?? DESCRIPTIONS['/']!);
</script>

<svelte:head>
	<title>{title}</title>
	<link rel="icon" href={favicon} />
	<link rel="canonical" href={canonical} />
	<meta name="description" content={description} />
	<meta property="og:site_name" content="fudrouter" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
</svelte:head>

<!-- Global chrome only. Each surface (public / member / admin) supplies its own
     header and navigation in its own +layout.svelte. -->
<NavProgress />

<main>
	{@render children()}
</main>

<style>
	main {
		max-width: 1100px;
		margin: 0 auto;
		padding: var(--space-lg);
	}
</style>
