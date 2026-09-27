<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/ui';

	let { data, children } = $props();

	const links = [
		{ href: '/dashboard', label: 'Dashboard' },
		{ href: '/dashboard/keys', label: 'API Keys' },
		{ href: '/dashboard/usage', label: 'Usage' },
		{ href: '/dashboard/account', label: 'Account' },
		{ href: '/dashboard/billing', label: 'Billing' }
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
		gap: var(--space-md);
		align-items: center;
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--color-border);
	}
	.brand {
		color: var(--color-text);
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
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.shell {
		display: grid;
		grid-template-columns: 12rem 1fr;
		gap: var(--space-lg);
		max-width: 1100px;
		margin: 0 auto;
		padding: var(--space-lg);
	}
	aside {
		display: grid;
		align-content: start;
		gap: var(--space-xs);
	}
	aside a {
		padding: var(--space-sm);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	aside a:hover {
		background: var(--color-surface);
		color: var(--color-text);
		text-decoration: none;
	}
	aside a.active {
		background: var(--color-surface);
		box-shadow: inset 2px 0 0 var(--primary);
		color: var(--color-text);
		font-weight: 600;
	}

	/* Grid items default to min-width:auto, so the content column refuses to
	   shrink below its widest child and pushes the page wider than the screen. */
	section {
		min-width: 0;
	}

	/* Below 820px: collapse to single column, nav becomes a
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
