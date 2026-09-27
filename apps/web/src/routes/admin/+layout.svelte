<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';

	let { data, children } = $props();

	// Each item declares the capability that unlocks it. Nav renders only what the
	// viewer can reach, so there are never dead links for a limited role.
	const items = [
		{ href: '/admin', label: 'Overview', cap: 'admin.view' },
		{ href: '/admin/providers', label: 'Providers', cap: 'admin.providers' },
		{ href: '/admin/models', label: 'Models', cap: 'admin.models' },
		{ href: '/admin/keys', label: 'API Keys', cap: 'admin.keys' },
		{ href: '/admin/users', label: 'Users', cap: 'admin.users' },
		{ href: '/admin/requests', label: 'Requests', cap: 'admin.requests' },
		{ href: '/admin/connections', label: 'Connections', cap: 'admin.ops' }
	] as const;
	const caps = $derived(new Set(data.caps ?? []));
	const visible = $derived(items.filter((i) => caps.has(i.cap)));
</script>

<!-- First focusable element on the page, so a keyboard user can jump the tabs. -->
<a class="skip-link" href="#content">Skip to content</a>

<nav class="admin-nav" aria-label="Admin sections">
	{#each visible as i (i.href)}
		<a
			href={resolve(i.href)}
			class:active={isActive(i.href)}
			aria-current={isActive(i.href) ? 'page' : undefined}>{i.label}</a
		>
	{/each}
</nav>

<div id="content">{@render children()}</div>

<style>
	.admin-nav {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		padding: var(--space-sm) var(--space-lg);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
	}
	.admin-nav a {
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		/* Standalone tab targets must clear 24x24 CSS px (WCAG 2.5.8). */
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.admin-nav a:hover {
		background: var(--color-surface-raised);
		color: var(--color-text);
		text-decoration: none;
	}
	.admin-nav a.active {
		background: var(--color-surface-raised);
		box-shadow: inset 0 -2px 0 var(--primary);
		color: var(--color-text);
		font-weight: 600;
	}

	/* Narrow screens: keep the tab strip on one scrollable row rather than
	   wrapping, which would strand the last tab on a line of its own.
	   Matches 820px in tokens.css. */
	@media (max-width: 820px) {
		.admin-nav {
			flex-wrap: nowrap;
			overflow-x: auto;
		}
		.admin-nav a {
			white-space: nowrap;
		}
	}
</style>
