<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/ui';

	let { data, children } = $props();

	const links = [
		{ href: '/dashboard', label: 'Dashboard' },
		{ href: '/keys', label: 'API Keys' },
		{ href: '/usage', label: 'Usage' },
		{ href: '/account', label: 'Account' }
	] as const;
	const isAdmin = $derived((data.caps ?? []).includes('admin.view'));
</script>

<!-- First focusable element on the page, so a keyboard user can jump the nav. -->
<a class="skip-link" href="#content">Skip to content</a>

<header class="appbar">
	<a class="brand" href={resolve('/')}>fudrouter</a>
	{#if isAdmin}<a href={resolve('/admin')}>Admin</a>{/if}
	<span class="spacer"></span>
	<span class="who">{data.user?.email} <span class="muted">({data.user?.role})</span></span>
	<form method="POST" action="/?/logout">
		<Button type="submit">Sign out</Button>
	</form>
</header>

<div class="shell">
	<aside aria-label="Sections">
		{#each links as l (l.href)}
			<a
				href={resolve(l.href)}
				class:active={isActive(l.href)}
				aria-current={isActive(l.href) ? 'page' : undefined}>{l.label}</a
			>
		{/each}
	</aside>
	<section id="content">
		{@render children()}
	</section>
</div>

<style>
	.appbar {
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
	/* Standalone header links must clear 24x24 CSS px (WCAG 2.5.8). */
	.appbar a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.brand:hover {
		text-decoration: none;
	}
	.spacer {
		margin-left: auto;
	}
	.who {
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	.shell {
		display: grid;
		grid-template-columns: 12rem 1fr;
		gap: var(--fr-space-lg);
		max-width: 1100px;
		margin: 0 auto;
		padding: var(--fr-space-lg);
	}
	aside {
		display: grid;
		align-content: start;
		gap: var(--fr-space-xs);
	}
	aside a {
		padding: var(--fr-space-sm);
		border-radius: var(--fr-radius-md);
		color: var(--fr-text-muted);
		font-size: var(--fr-text-sm);
	}
	aside a:hover {
		background: var(--fr-surface);
		color: var(--fr-text);
		text-decoration: none;
	}
	aside a.active {
		background: var(--fr-surface);
		box-shadow: inset 2px 0 0 var(--fr-primary);
		color: var(--fr-text);
		font-weight: 600;
	}

	/* Grid items default to min-width:auto, so the content column refuses to
	   shrink below its widest child and pushes the page wider than the screen. */
	section {
		min-width: 0;
	}

	/* Below --fr-bp-tablet: collapse to single column, nav becomes a
	   scrollable row. */
	@media (max-width: 820px) {
		.shell {
			grid-template-columns: 1fr;
		}
		/* One scrollable row, not a wrapped block: wrapping orphans the last item
		   on a line of its own and reads as a layout accident. */
		aside {
			display: flex;
			flex-wrap: nowrap;
			overflow-x: auto;
		}
		aside a {
			white-space: nowrap;
		}
		.who {
			display: none;
		}
	}
</style>
