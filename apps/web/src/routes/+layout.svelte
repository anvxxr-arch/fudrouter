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
</script>

<svelte:head>
	<title>{title}</title>
	<link rel="icon" href={favicon} />
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
		padding: var(--fr-space-lg);
	}
</style>
