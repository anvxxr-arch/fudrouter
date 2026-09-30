<script lang="ts">
	import { isActive } from '$lib/nav';
	import { resolve } from '$app/paths';
	let { data, children } = $props();
	// Admin IA (PRD §50/§142): grouped sidebar, one capability gate per item.
	// Nav renders only what the viewer can reach, so there are never dead links
	// for a limited role. `admin.audit` gates Audit Logs; Security/System/Jobs/
	// Events/Incidents ride `admin.ops`; Traffic rides `admin.ops`; Billing rides
	// `admin.billing`; Settings rides `admin.settings`.
	const groups = [
		{
			label: null,
			items: [{ href: '/admin', label: 'Overview', cap: 'admin.view' }]
		},
		{
			label: 'Network',
			items: [
				{ href: '/admin/providers', label: 'Providers', cap: 'admin.providers' },
				{ href: '/admin/models', label: 'Models', cap: 'admin.models' },
				{ href: '/admin/routing', label: 'Routing', cap: 'admin.ops' },
				{ href: '/admin/traffic', label: 'Traffic', cap: 'admin.ops' }
			]
		},
		{
			label: 'Observability',
			items: [
				{ href: '/admin/requests', label: 'Requests', cap: 'admin.requests' },
				{ href: '/admin/analytics', label: 'Analytics', cap: 'admin.view' },
				{ href: '/admin/health', label: 'Health', cap: 'admin.ops' }
			]
		},
		{
			label: 'Customers',
			items: [
				{ href: '/admin/users', label: 'Users', cap: 'admin.users' },
				{ href: '/admin/workspaces', label: 'Workspaces', cap: 'admin.users' },
				{ href: '/admin/projects', label: 'Projects', cap: 'admin.users' },
				{ href: '/admin/keys', label: 'API Keys', cap: 'admin.keys' }
			]
		},
		{
			label: 'Revenue',
			items: [{ href: '/admin/billing', label: 'Billing', cap: 'admin.billing' }]
		},
		{
			label: 'Security',
			items: [
				{ href: '/admin/security', label: 'Abuse', cap: 'admin.audit' },
				{ href: '/admin/security/audit-log', label: 'Audit Logs', cap: 'admin.audit' }
			]
		},
		{
			label: 'Infrastructure',
			items: [
				{ href: '/admin/system', label: 'System', cap: 'admin.ops' },
				{ href: '/admin/system/jobs', label: 'Jobs', cap: 'admin.ops' },
				{ href: '/admin/system/events', label: 'Events', cap: 'admin.ops' },
				{ href: '/admin/incidents', label: 'Incidents', cap: 'admin.ops' }
			]
		},
		{
			label: 'Configuration',
			items: [{ href: '/admin/settings', label: 'Settings', cap: 'admin.settings' }]
		}
	] as const;
	const caps = $derived(new Set(data.caps ?? []));
	const visible = $derived(
		groups
			.map((g) => ({ ...g, items: g.items.filter((i) => caps.has(i.cap)) }))
			.filter((g) => g.items.length > 0)
	);
</script>
<!-- First focusable element on the page, so a keyboard user can jump the nav. -->
<a class="skip-link" href="#content">Skip to content</a>
<div class="admin-shell">
	<nav class="admin-nav" aria-label="Admin sections">
		{#each visible as group (group.label ?? 'top')}
			<div class="nav-group">
				{#if group.label}<span class="nav-group-label">{group.label}</span>{/if}
				{#each group.items as i (i.href)}
					<a
						href={resolve(i.href)}
						class:active={isActive(i.href)}
						aria-current={isActive(i.href) ? 'page' : undefined}>{i.label}</a
					>
				{/each}
			</div>
		{/each}
	</nav>
	<div id="content" class="admin-content">{@render children()}</div>
</div>
<style>
	.admin-shell {
		display: flex;
		align-items: flex-start;
		gap: var(--space-lg);
	}
	.admin-nav {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-md);
		border-right: 1px solid var(--color-border);
		background: var(--color-surface);
		min-width: 11rem;
	}
	.nav-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nav-group-label {
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		padding: 0 var(--space-sm) var(--space-xs);
	}
	.admin-nav a {
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		/* Standalone targets must clear 24x24 CSS px (WCAG 2.5.8). */
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
		box-shadow: inset -2px 0 0 var(--primary);
		color: var(--color-text);
		font-weight: 600;
	}
	.admin-content {
		flex: 1;
		min-width: 0;
	}
	/* Narrow screens: the sidebar becomes a horizontal scroll strip rather than
	   squeezing the content column to nothing. Matches 820px in tokens.css. */
	@media (max-width: 820px) {
		.admin-shell {
			flex-direction: column;
		}
		.admin-nav {
			flex-direction: row;
			flex-wrap: nowrap;
			overflow-x: auto;
			border-right: none;
			border-bottom: 1px solid var(--color-border);
			width: 100%;
		}
		.nav-group {
			flex-direction: row;
			align-items: center;
		}
		.nav-group-label {
			padding: 0 var(--space-sm);
			white-space: nowrap;
		}
		.admin-nav a {
			white-space: nowrap;
		}
	}
</style>
