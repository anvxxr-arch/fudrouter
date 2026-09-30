<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { Button, EmptyState, Input, Select, TableWrap } from '$lib/ui';
	import {
		applyView,
		defaultView,
		toggleAllOnPage,
		toggleColumn,
		toggleSelection,
		type Column,
		type FilterSpec,
		type TableView
	} from '$lib/table';

	/**
	 * Universal table shell (PRD §107): search, sort, filter, paginate, column
	 * visibility, selection, and the empty/loading/error states (PRD §108).
	 *
	 * The engine lives in `$lib/table` as a pure function of (rows, view), so the
	 * behaviour is testable without a browser and every consumer gets the same
	 * rules. This component only owns presentation and interaction.
	 */
	let {
		caption,
		rows,
		columns,
		keyOf,
		selectable = false,
		filters = [],
		empty = { title: 'Nothing here yet', hint: undefined },
		loading = false,
		error = null,
		rowActions,
		bulkActions,
		toolbar,
		pageSize = 25
	}: {
		caption: string;
		rows: T[];
		columns: Column<T>[];
		keyOf: (row: T) => string;
		selectable?: boolean;
		filters?: FilterSpec[];
		empty?: { title: string; hint?: string };
		loading?: boolean;
		error?: string | null;
		rowActions?: Snippet<[T]>;
		bulkActions?: Snippet<[string[]]>;
		toolbar?: Snippet;
		pageSize?: number;
	} = $props();

	// The view state resets its sort/page only through explicit UI events; the
	// rows themselves may change underneath (a revalidated load) without
	// yanking the user's place in the table. Initializing from `columns`/
	// `pageSize` once is the point — a later re-render must not reset the view.
	// svelte-ignore state_referenced_locally
	let view: TableView = $state(defaultView(columns, pageSize));
	let selected: string[] = $state([]);
	let columnsOpen = $state(false);

	const result = $derived(applyView(rows, columns, view));
	const pageIds = $derived(result.pageRows.map(keyOf));
	const allOnPageSelected = $derived(pageIds.length > 0 && pageIds.every((id) => selected.includes(id)));

	function sortBy(key: string): void {
		if (view.sortKey === key) {
			view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			view = { ...view, sortKey: key, sortDir: 'asc', page: 1 };
		}
	}
</script>

<div class="fr-table-tool">
	{#if toolbar}{@render toolbar()}{/if}
	<label class="fr-table-search">
		<span class="sr-only">Search {caption}</span>
		<Input placeholder="Search {caption}…" bind:value={view.query} oninput={() => (view.page = 1)} />
	</label>
	{#each filters as f (f.key)}
		<label class="fr-table-filter">
			<span class="fr-table-filter-label">{f.label}</span>
			<Select
				bind:value={view.filters[f.key]}
				onchange={() => (view.page = 1)}
			>
				<option value="">All</option>
				{#each f.options as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</Select>
		</label>
	{/each}
	<div class="fr-table-columns">
		<Button size="sm" aria-expanded={columnsOpen} onclick={() => (columnsOpen = !columnsOpen)}>
			Columns
		</Button>
		{#if columnsOpen}
			<div class="fr-columns-menu" role="group" aria-label="Visible columns">
				{#each columns as col (col.key)}
					<label>
						<input
							type="checkbox"
							checked={!view.hiddenColumns.includes(col.key)}
							onchange={() => (view = toggleColumn(view, col.key))}
						/>
						{col.label}
					</label>
				{/each}
			</div>
		{/if}
	</div>
</div>

{#if error}
	<p class="fr-table-error" role="alert">{error}</p>
{:else if loading}
	<p class="fr-table-status" role="status">Loading {caption}…</p>
{:else if result.total === 0}
	<EmptyState title={empty.title} hint={empty.hint} />
{:else}
	<TableWrap label={caption}>
		<table>
			<caption class="sr-only">{caption}</caption>
			<thead>
				<tr>
					{#if selectable}
						<th scope="col">
							<input
								type="checkbox"
								aria-label="Select all rows on this page"
								checked={allOnPageSelected}
								onchange={() => (selected = toggleAllOnPage(selected, pageIds))}
							/>
						</th>
					{/if}
					{#each result.visibleColumns as col (col.key)}
						<th scope="col" class:align-end={col.align === 'end'}>
							{#if col.sortable !== false && col.sortable !== undefined}
								<button type="button" class="fr-sort" onclick={() => sortBy(col.key)}>
									{col.label}{view.sortKey === col.key ? (view.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
								</button>
							{:else}
								{col.label}
							{/if}
						</th>
					{/each}
					{#if rowActions}<th scope="col"><span class="sr-only">Actions</span></th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each result.pageRows as row (keyOf(row))}
					<tr>
						{#if selectable}
							<td>
								<input
									type="checkbox"
									aria-label="Select row"
									checked={selected.includes(keyOf(row))}
									onchange={() => (selected = toggleSelection(selected, keyOf(row)))}
								/>
							</td>
						{/if}
						{#each result.visibleColumns as col (col.key)}
							<td class:align-end={col.align === 'end'}>{col.value(row) ?? '—'}</td>
						{/each}
						{#if rowActions}
							<td class="fr-row-actions">{@render rowActions(row)}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	{#if bulkActions && selected.length > 0}
		<div class="fr-bulk" role="status">
			<span>{selected.length} selected</span>
			{@render bulkActions(selected)}
			<Button size="sm" variant="ghost" onclick={() => (selected = [])}>Clear</Button>
		</div>
	{/if}
	{#if result.pageCount > 1}
		<nav class="fr-pager" aria-label="{caption} pages">
			<Button size="sm" disabled={view.page <= 1} onclick={() => (view.page -= 1)}>Previous</Button>
			<span>Page {Math.min(view.page, result.pageCount)} of {result.pageCount}</span>
			<Button
				size="sm"
				disabled={view.page >= result.pageCount}
				onclick={() => (view.page += 1)}>Next</Button
			>
		</nav>
	{/if}
{/if}

<style>
	.fr-table-tool {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: end;
		margin-bottom: var(--space-md);
	}
	.fr-table-search {
		flex: 1 1 12rem;
		min-width: 0;
	}
	.fr-table-filter {
		display: grid;
		gap: var(--space-xs);
	}
	.fr-table-filter-label {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}
	.fr-table-columns {
		position: relative;
	}
	.fr-columns-menu {
		position: absolute;
		right: 0;
		top: calc(100% + var(--space-xs));
		z-index: 10;
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-sm);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	.fr-columns-menu label {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
		font-size: var(--text-sm);
	}
	.fr-sort {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.align-end {
		text-align: right;
	}
	.fr-row-actions {
		white-space: nowrap;
	}
	.fr-bulk {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		margin-top: var(--space-sm);
		padding: var(--space-sm);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	.fr-pager {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		margin-top: var(--space-md);
	}
	.fr-table-error {
		color: var(--color-danger);
	}
	.fr-table-status {
		color: var(--color-text-muted);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
