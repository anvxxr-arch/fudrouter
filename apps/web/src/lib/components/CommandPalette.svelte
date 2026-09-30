<script lang="ts">
	import { goto } from '$app/navigation';
	import { Alert, Button, Input } from '$lib/ui';
	import {
		assembleGroups,
		filterActions,
		rankItems,
		type PaletteItem
	} from '$lib/palette';

	/**
	 * Global command palette (PRD §106): Ctrl/Cmd+K anywhere in the app.
	 *
	 * Self-contained on purpose — the shell mounts `<CommandPalette />` with no
	 * props and the component binds its own keyboard shortcut, so no layout has
	 * to know how it works. `gotoFn` is injectable for tests.
	 */
	let { gotoFn = goto }: { gotoFn?: (href: string) => void } = $props();

	const ENDPOINTS = [
		'projects',
		'keys',
		'models',
		'providers',
		'requests',
		'workspaces'
	] as const;

	let open = $state(false);
	let query = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let items: PaletteItem[] = $state([]);
	let activeIndex = $state(0);
	let workspaceMode = $state(false);
	let inputEl: HTMLInputElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();

	// The five PRD §106 actions. 'Switch workspace' flips to the workspace list
	// (fetched alongside the search groups) instead of navigating.
	const actions = $derived(
		filterActions(
			[
				{ id: 'new-project', title: 'Create project', hint: 'PRD §44', run: () => navigate('/dashboard/projects/new') },
				{ id: 'new-key', title: 'Create API key', hint: 'PRD §25', run: () => navigate('/dashboard/keys') },
				{ id: 'open-playground', title: 'Open playground', hint: 'PRD §27', run: () => navigate('/dashboard/playground') },
				// No request list lives under a stable URL without a project id, and
				// guessing one would 404; the project picker is the honest target.
				{ id: 'open-requests', title: 'Open requests', hint: 'PRD §28', run: () => navigate('/dashboard/projects') },
				{
					id: 'switch-workspace',
					title: 'Switch workspace',
					hint: 'PRD §141',
					run: () => (workspaceMode = true)
				}
			],
			query
		)
	);

	const ranked = $derived(rankItems(items, query));
	const groups = $derived(
		assembleGroups(workspaceMode ? ranked.filter((i) => i.type === 'workspace') : ranked)
	);
	// One flat list drives keyboard navigation: actions first, then result rows.
	// Workspace rows switch context instead of navigating (PRD §141).
	const entries = $derived([
		...actions.map((a) => ({ id: `action:${a.id}`, title: a.title, hint: a.hint ?? 'Action', run: a.run })),
		...groups.flatMap((g) =>
			g.items.map((i) => ({
				id: `item:${i.id}`,
				title: i.title,
				hint: i.subtitle,
				run: () => (i.type === 'workspace' ? pickWorkspace(i.id) : navigate(i.href))
			}))
		)
	]);

	function navigate(href: string): void {
		open = false;
		gotoFn(href);
	}

	async function search(): Promise<void> {
		loading = true;
		error = null;
		try {
			const responses = await Promise.all(
				ENDPOINTS.map((name) =>
					fetch(`/api/palette/${name}?q=${encodeURIComponent(query)}&limit=8`, {
						credentials: 'same-origin'
					}).then((r) => {
						if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
						return r.json() as Promise<{ items: PaletteItem[] }>;
					})
				)
			);
			items = responses.flatMap((r) => r.items ?? []);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Search failed.';
		} finally {
			loading = false;
			activeIndex = 0;
		}
	}

	async function pickWorkspace(id: string): Promise<void> {
		const body = new FormData();
		body.set('workspaceId', id);
		// One place owns the fwid cookie (PRD §141) — the workspace page's
		// switchWorkspace action — so the palette never writes context cookies.
		await fetch('/dashboard/workspace?/switchWorkspace', {
			method: 'POST',
			body,
			credentials: 'same-origin'
		});
		open = false;
		location.reload();
	}

	function toggle(): void {
		open = !open;
		if (open) {
			workspaceMode = false;
			void search();
			// Focus only once the dialog exists in the DOM.
			setTimeout(() => inputEl?.focus(), 0);
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			toggle();
			return;
		}
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, entries.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			entries[activeIndex]?.run();
		}
	}

	// Debounce keystrokes so a fast typist makes one request per pause, not one
	// per key.
	$effect(() => {
		query;
		if (!open) return;
		const t = setTimeout(() => void search(), 150);
		return () => clearTimeout(t);
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class="fr-palette-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
	>
		<div
			class="fr-palette"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			bind:this={panelEl}
		>
			<label class="sr-only" for="palette-input">Search projects, keys, models, providers, requests</label>
			<Input
				id="palette-input"
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={entries[activeIndex] ? `palette-opt-${activeIndex}` : undefined}
				placeholder="Search or run a command… (Ctrl+K)"
				bind:value={query}
			/>
			{#if workspaceMode}
				<p class="fr-palette-mode">
					Switching workspace… <button type="button" onclick={() => (workspaceMode = false)}>back</button>
				</p>
			{/if}
			{#if loading}
				<p class="fr-palette-status" role="status">Searching…</p>
			{:else if error}
				<Alert tone="danger">
					{error}
					<Button size="sm" onclick={() => void search()}>Retry</Button>
				</Alert>
			{:else if entries.length === 0}
				<p class="fr-palette-status">No matches</p>
			{:else}
				<ul id="palette-list" role="listbox" aria-label="Results" class="fr-palette-list">
					{#each entries as entry, i (entry.id)}
						<li
							id={`palette-opt-${i}`}
							role="option"
							aria-selected={i === activeIndex}
							class:active={i === activeIndex}
						>
							<button type="button" onmouseenter={() => (activeIndex = i)} onclick={entry.run}>
								<span class="fr-palette-title">{entry.title}</span>
								<span class="fr-palette-hint">{entry.hint}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			<p class="fr-palette-help">↑↓ to move · Enter to open · Esc to close</p>
		</div>
	</div>
{/if}

<style>
	.fr-palette-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: start center;
		padding-top: 10vh;
		background: rgb(0 0 0 / 0.5);
	}
	.fr-palette {
		display: grid;
		gap: var(--space-sm);
		width: min(34rem, calc(100vw - 2rem));
		padding: var(--space-md);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	.fr-palette-list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 50vh;
		overflow-y: auto;
	}
	.fr-palette-list button {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		width: 100%;
		padding: var(--space-sm);
		background: none;
		border: 0;
		border-radius: var(--radius-md);
		font: inherit;
		color: inherit;
		cursor: pointer;
		text-align: start;
	}
	.fr-palette-list li.active button {
		background: var(--color-background);
		box-shadow: inset 2px 0 0 var(--primary);
	}
	.fr-palette-hint {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.fr-palette-status,
	.fr-palette-help,
	.fr-palette-mode {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
