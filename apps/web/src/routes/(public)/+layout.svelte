<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';

	let { data, children } = $props();

	const links = [
		{ href: '/models', label: 'Models' },
		{ href: '/providers', label: 'Providers' },
		{ href: '/pricing', label: 'Pricing' },
		{ href: '/playground', label: 'Playground' },
		{ href: '/docs', label: 'Docs' },
		{ href: '/status', label: 'Status' }
	] as const;
</script>

<!-- First focusable element on the page, so a keyboard user can jump the nav. -->
<a class="skip-link" href="#content">Skip to content</a>

<header class="pub">
	<a class="brand" href={resolve('/')}>fudrouter</a>
	<nav aria-label="Primary">
		{#each links as l (l.href)}
			<!-- Plain hrefs: `paths.relative: false` makes these absolute already, and
			     the typed `resolve()` overload needs one literal RouteId per call —
			     a union of hrefs (and /docs since the catch-all landed) cannot
			     satisfy it. -->
			<a
				href={l.href}
				class:active={isActive(l.href)}
				aria-current={isActive(l.href) ? 'page' : undefined}>{l.label}</a
			>
		{/each}
	</nav>
	<span class="spacer"></span>
	{#if data.user}
		<a href={resolve('/dashboard')}>Dashboard</a>
	{:else}
		<a href={resolve('/login')}>Log in</a>
		<a class="cta" href={resolve('/signup')}>Get started</a>
	{/if}
</header>

<div id="content">{@render children()}</div>

<footer>
	<span>© fudrouter — commercial AI router</span>
	<span class="legal">
		<a href={resolve('/status')}>Status</a>
		<a href={resolve('/changelog')}>Changelog</a>
		<a href={resolve('/legal/terms')}>Terms</a>
		<a href={resolve('/legal/privacy')}>Privacy</a>
	</span>
</footer>

<style>
	.pub {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		align-items: center;
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--color-border);
	}
	.brand {
		color: var(--color-text);
		font-weight: 700;
	}
	/*
	 * Header links are standalone pointer targets, not links inside running text,
	 * so each must clear 24x24 CSS px (WCAG 2.5.8). Without the floor the brand and
	 * the Log in link measured 23px tall.
	 */
	.pub a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.brand:hover {
		text-decoration: none;
	}
	.pub nav {
		display: flex;
		gap: var(--space-md);
	}
	.pub nav a {
		padding: var(--space-xs) 0;
		border-bottom: 2px solid transparent;
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.pub nav a:hover {
		color: var(--color-text);
		text-decoration: none;
	}
	.pub nav a.active {
		border-bottom-color: var(--primary);
		color: var(--color-text);
	}
	.spacer {
		margin-left: auto;
	}
	.cta {
		padding: var(--space-sm) var(--space-md);
		background: var(--primary);
		color: var(--on-primary);
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.cta:hover {
		background: var(--primary-hover);
		text-decoration: none;
	}
	footer {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		margin-top: var(--space-2xl);
		padding: var(--space-md) var(--space-lg);
		border-top: 1px solid var(--color-border);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.legal {
		display: flex;
		gap: var(--space-md);
	}
	/* WCAG 2.5.8: standalone footer links must be >= 24px tall. */
	.legal a {
		min-height: 24px;
		display: inline-flex;
		align-items: center;
	}
</style>
