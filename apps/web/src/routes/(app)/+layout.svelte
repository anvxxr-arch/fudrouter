<script lang="ts">
	import { isActive } from '$lib/nav';
	import { base, resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { Button } from '$lib/ui';
	let { data, children } = $props();

	// PRD §141 shell: switchers first, then the grouped nav. Every href is a
	// LITERAL route pattern — `/dashboard/projects/[projectId]/…` included —
	// because the nav-reachability rule matches these strings against the route
	// tree. Resolution is base + pattern substitution: `resolve()` needs a
	// literal RouteId at each call site (ResolveArgs), and these iterate a union
	// of patterns, so the typed overload cannot see one. Without a project the
	// param routes collapse to the projects list — never a double-slash URL.
	const navHref = (pattern: string): string => {
		if (pattern.includes('[projectId]')) {
			const pid = data.shell?.projectId;
			return pid ? base + pattern.replace('[projectId]', pid) : base + '/dashboard/projects';
		}
		return base + pattern;
	};

	// CONTEXTUAL entries (project manage, team manage, billing, personal) live in
	// their own sub-lists so the primary sidebar stays the §141 group set.
	const groups = [
		{
			label: '',
			items: [
				{ href: '/dashboard', label: 'Dashboard' },
				{ href: '/dashboard/projects', label: 'Projects' }
			]
		},
		{
			label: 'BUILD',
			items: [
				{ href: '/dashboard/playground', label: 'Playground' },
				{ href: '/dashboard/connect', label: 'Connect a client' },
				{ href: '/dashboard/projects/[projectId]/keys', label: 'API Keys' },
				{ href: '/dashboard/projects/[projectId]/routing', label: 'Routing' }
			]
		},
		{
			label: 'OBSERVE',
			items: [
				{ href: '/dashboard/projects/[projectId]/requests', label: 'Requests' },
				{ href: '/dashboard/projects/[projectId]/analytics', label: 'Analytics' },
				{ href: '/dashboard/usage', label: 'Usage' }
			]
		},
		{
			label: 'CONTROL',
			items: [
				{ href: '/dashboard/projects/[projectId]/limits', label: 'Limits' },
				{ href: '/dashboard/projects/[projectId]/budgets', label: 'Budgets' },
				{ href: '/dashboard/projects/[projectId]/alerts', label: 'Alerts' }
			]
		},
		{
			label: 'WORKSPACE',
			items: [
				{ href: '/dashboard/billing', label: 'Billing' },
				{ href: '/dashboard/team', label: 'Team' }
			]
		},
		{
			label: '',
			items: [
				{ href: '/dashboard/workspace', label: 'Settings' },
				{ href: '/docs', label: 'Docs' }
			]
		}
	] as const;
	const contextual = [
		{
			label: 'PROJECT',
			items: [
				{ href: '/dashboard/projects/new', label: 'New project' },
				{ href: '/dashboard/projects/[projectId]', label: 'Project overview' },
				{ href: '/dashboard/projects/[projectId]/environments', label: 'Environments' },
				{ href: '/dashboard/projects/[projectId]/playground', label: 'Project playground' },
				{ href: '/dashboard/projects/[projectId]/aliases', label: 'Model aliases' },
				{ href: '/dashboard/projects/[projectId]/settings', label: 'Project settings' },
				{ href: '/dashboard/projects/[projectId]/keys/[keyId]', label: 'API key detail' },
				{
					href: '/dashboard/projects/[projectId]/requests/[requestId]',
					label: 'Request detail'
				}
			]
		},
		{
			label: 'TEAM',
			items: [
				{ href: '/dashboard/team/members', label: 'Members' },
				{ href: '/dashboard/team/invitations', label: 'Invitations' },
				{ href: '/dashboard/team/roles', label: 'Roles' },
				{ href: '/invite/[token]', label: 'Accept invitation' }
			]
		},
		{
			label: 'BILLING',
			items: [
				{ href: '/dashboard/billing/credits', label: 'Credits' },
				{ href: '/dashboard/billing/transactions', label: 'Transactions' },
				{ href: '/dashboard/billing/invoices', label: 'Invoices' },
				{ href: '/dashboard/billing/payment-methods', label: 'Payment methods' }
			]
		},
		{
			label: 'PERSONAL',
			items: [
				{ href: '/dashboard/keys', label: 'Personal API keys' },
				{ href: '/dashboard/account', label: 'Account' }
			]
		}
	] as const;
	const isAdmin = $derived((data.caps ?? []).includes('admin.view'));
	const shell = $derived(data.shell);
	const active = (pattern: string) => isActive(navHref(pattern));
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
		<!-- Workspace / project / environment switchers (PRD §141). Each posts to a
		     membership-checked action on /dashboard/workspace; a switch is a real
		     server-side state change, never a client-side guess. -->
		{#if shell}
			<div class="switchers">
				<form method="POST" action="/dashboard/workspace?/switchWorkspace" class="switcher">
					<label class="switcher-label" for="fwid-switch">Workspace</label>
					<select id="fwid-switch" name="workspaceId" class="switcher-select">
						{#each shell.workspaces as w (w.id)}
							<option value={w.id} selected={w.id === shell.workspaceId}>{w.name}</option>
						{/each}
					</select>
					<button type="submit" class="switcher-go">Go</button>
				</form>
				<form method="POST" action="/dashboard/workspace?/switchProject" class="switcher">
					<label class="switcher-label" for="fpid-switch">Project</label>
					<select id="fpid-switch" name="projectId" class="switcher-select">
						{#each shell.projects as p (p.id)}
							<option value={p.id} selected={p.id === shell.projectId}>{p.name}</option>
						{/each}
					</select>
					<button type="submit" class="switcher-go">Go</button>
				</form>
				<form method="POST" action="/dashboard/workspace?/switchEnvironment" class="switcher">
					<label class="switcher-label" for="feid-switch">Environment</label>
					<select id="feid-switch" name="environmentId" class="switcher-select">
						{#each shell.environments as e (e.id)}
							<option value={e.id} selected={e.id === shell.environmentId}>{e.name}</option>
						{/each}
					</select>
					<button type="submit" class="switcher-go">Go</button>
				</form>
			</div>
		{/if}
		{#each groups as g (g.items[0].href)}
			{#if g.label}<span class="nav-group" id="nav-{g.label.toLowerCase()}">{g.label}</span>{/if}
			{#each g.items as l (l.href)}
				<a
					href={navHref(l.href)}
					class:active={active(l.href)}
					aria-current={active(l.href) ? 'page' : undefined}>{l.label}</a
				>
			{/each}
		{/each}
		{#each contextual as g (g.items[0].href)}
			<span class="nav-group" id="nav-{g.label.toLowerCase()}">{g.label}</span>
			{#each g.items as l (l.href)}
				<a
					href={navHref(l.href)}
					class:active={active(l.href)}
					aria-current={active(l.href) ? 'page' : undefined}>{l.label}</a
				>
			{/each}
		{/each}
	</aside>
	<section id="content">
		{@render children()}
	</section>
</div>
<CommandPalette />
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
		grid-template-columns: 14rem 1fr;
		gap: var(--space-lg);
		max-width: 1100px;
		margin: 0 auto;
		padding: var(--space-lg);
	}
	aside {
		display: grid;
		grid-auto-flow: row;
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
	.nav-group {
		margin-top: var(--space-sm);
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
	}
	.switchers {
		display: grid;
		gap: var(--space-sm);
		padding-bottom: var(--space-sm);
		border-bottom: 1px solid var(--color-border);
		margin-bottom: var(--space-xs);
	}
	.switcher {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: var(--space-xs);
		align-items: center;
	}
	.switcher-label {
		grid-column: 1 / -1;
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.switcher-select {
		min-width: 0;
		padding: var(--space-xs);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--text-sm);
	}
	.switcher-go {
		padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.switcher-go:hover {
		border-color: var(--primary);
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
