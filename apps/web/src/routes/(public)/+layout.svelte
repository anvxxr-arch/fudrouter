<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';

	let { data, children } = $props();

	const links = [
		{ href: '/pricing', label: 'Pricing' },
		{ href: '/models', label: 'Models' },
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
			<a
				href={resolve(l.href)}
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
		<a href={resolve('/legal/terms')}>Terms</a>
		<a href={resolve('/legal/privacy')}>Privacy</a>
	</span>
</footer>

<style>
	.pub {
		display: flex;
		flex-wrap: wrap;
		gap: var(--fr-space-md);
		align-items: center;
		padding: var(--fr-space-md) var(--fr-space-lg);
		border-bottom: 1px solid var(--fr-border);
	}
	.brand {
		color: var(--fr-text);
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
		gap: var(--fr-space-md);
	}
	.pub nav a {
		padding: var(--fr-space-xs) 0;
		border-bottom: 2px solid transparent;
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.pub nav a:hover {
		color: var(--fr-text);
		text-decoration: none;
	}
	.pub nav a.active {
		border-bottom-color: var(--fr-primary);
		color: var(--fr-text);
	}
	.spacer {
		margin-left: auto;
	}
	.cta {
		padding: var(--fr-space-sm) var(--fr-space-md);
		background: var(--fr-primary);
		color: var(--fr-on-primary);
		border-radius: var(--fr-radius-md);
		font-size: var(--fr-text-sm);
		font-weight: 600;
	}
	.cta:hover {
		background: var(--fr-primary-hover);
		text-decoration: none;
	}
	footer {
		display: flex;
		justify-content: space-between;
		gap: var(--fr-space-md);
		margin-top: var(--fr-space-2xl);
		padding: var(--fr-space-md) var(--fr-space-lg);
		border-top: 1px solid var(--fr-border);
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.legal {
		display: flex;
		gap: var(--fr-space-md);
	}
</style>
