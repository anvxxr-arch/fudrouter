<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		CodeBlock,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import DataTable from '$lib/components/DataTable.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import type { Column } from '$lib/table';
	import { WARNING_TARGET_STATUSES } from '$lib/alias-form';
	import type { PageData } from './$types';

	type AliasRow = PageData['aliases'][number];
	type ModelOption = PageData['models'][number];

	let { data, form } = $props();

	// One flag for the page: any in-flight action disables every submit, which also
	// stops a double-click from firing two creates.
	let pending = $state(false);
	const track = withPending((v) => (pending = v));

	// ---- create form state ----
	let newName = $state('');
	let newDescription = $state('');
	let newEnabled = $state(true);
	let newScope = $state<'project' | 'workspace'>('project');
	let newTargets = $state<string[]>([]);

	// ---- edit form state (same shape, filled from the row being edited) ----
	let editing = $state<AliasRow | null>(null);
	let editName = $state('');
	let editDescription = $state('');
	let editEnabled = $state(true);
	let editScope = $state<'project' | 'workspace'>('project');
	let editTargets = $state<string[]>([]);

	let deleteTarget = $state<AliasRow | null>(null);
	let confirmOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();

	const byId = $derived(new Map(data.models.map((m: ModelOption) => [m.id, m])));
	/** PRD §125: deprecated/sunset targets are flagged wherever they are shown. */
	const flagged = (row: AliasRow) =>
		row.targets.filter((t) => t.status in WARNING_TARGET_STATUSES);
	const slugOf = (id: string) => byId.get(id)?.slug ?? id;
	const statusOf = (id: string) => byId.get(id)?.status ?? 'unknown';

	/** Order is the fallback chain (position 1 is primary), so moves are swaps. */
	function swap(list: string[], from: number, to: number): string[] {
		if (to < 0 || to >= list.length) return list;
		const out = [...list];
		[out[from], out[to]] = [out[to], out[from]];
		return out;
	}

	function setPrimary(list: string[], id: string): string[] {
		// A model already in the fallbacks moves up instead of duplicating —
		// the server rejects duplicate targets, so the UI must never offer them.
		// The displaced primary stays in the chain as the first fallback.
		if (!id) return list;
		const rest = list.filter((t) => t !== id);
		return [id, ...rest];
	}

	function addFallback(list: string[], id: string): string[] {
		if (!id || list.includes(id)) return list;
		return list.length === 0 ? [id] : [...list, id];
	}

	function startEdit(row: AliasRow): void {
		editing = row;
		editName = row.name;
		editDescription = row.description ?? '';
		editEnabled = row.enabled;
		editScope = row.scope === 'workspace' ? 'workspace' : 'project';
		editTargets = row.targets.map((t) => t.modelId);
	}

	function handleSelect(setter: (v: string) => void) {
		return (e: Event) => {
			const select = e.currentTarget as HTMLSelectElement; // DOM event target is narrowed, not trusted data
			setter(select.value);
		};
	}

	// A successful update closes the editor; a failed one keeps it open with the
	// user's input so the error can be fixed and resubmitted.
	$effect(() => {
		if (form?.updated) editing = null;
	});

	const columns: Column<AliasRow>[] = [
		{ key: 'name', label: 'Name', value: (r) => r.name, sortable: true },
		{ key: 'scope', label: 'Scope', value: (r) => r.scope, sortable: true },
		{ key: 'description', label: 'Description', value: (r) => r.description ?? '', sortable: true },
		{ key: 'enabled', label: 'Enabled', value: (r) => (r.enabled ? 'enabled' : 'disabled'), sortable: true },
		{ key: 'targets', label: 'Targets', value: (r) => r.targets.map((t) => t.slug).join(' → '), sortable: true },
		{
			key: 'status',
			label: 'Status',
			sortable: true,
			value: (r) => {
				if (!r.enabled) return 'disabled';
				const flaggedSlugs = flagged(r).map((t) => t.slug);
				return flaggedSlugs.length ? `${flagged(r)[0].status} target: ${flaggedSlugs.join(', ')}` : 'ready';
			}
		}
	];
</script>

<PageHeader
	title="Model aliases"
	lede="One name for a chain of models. Your app sends the alias; you reorder its targets here without a redeploy."
/>
<Guide id="aliases" />

{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Alias “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Alias “{form.updated}” saved.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Alias “{form.deleted}” deleted.</Alert></div>
{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}

<Card>
	<h2>Create alias</h2>
	<form method="POST" action="?/create" use:enhance={track} class="stack">
		<Field label="Name" hint="2–64 characters: lowercase letters, digits and dashes.">
			<Input name="name" bind:value={newName} placeholder="fast-primary" required />
		</Field>
		<Field label="Description" hint="Why this alias exists — shown to your team.">
			<Textarea name="description" rows="2" bind:value={newDescription}></Textarea>
		</Field>
		<Field label="Scope">
			<Select
				name="scope"
				value={newScope}
				onchange={handleSelect((v) => (newScope = v === 'workspace' ? 'workspace' : 'project'))}
			>
				<option value="project">project — only this project resolves it</option>
				<option value="workspace">workspace — every project in this workspace</option>
			</Select>
		</Field>
		<label class="check">
			<input type="checkbox" name="enabled" value="yes" bind:checked={newEnabled} />
			Enabled
		</label>

		<Field label="Primary model" hint="Position 1 — where requests land first.">
			<Select value={newTargets[0] ?? ''} onchange={handleSelect((v) => (newTargets = setPrimary(newTargets, v)))}>
				<option value="">Choose a model…</option>
				{#each data.models as m (m.id)}
					<option value={m.id} disabled={newTargets.includes(m.id) && newTargets[0] !== m.id}>
						{m.slug}{m.developer ? ` — ${m.developer}` : ''}
					</option>
				{/each}
			</Select>
		</Field>

		{#if newTargets.length > 1}
			<div class="stack">
				<span class="fr-label">Fallbacks</span>
				{#each newTargets.slice(1) as id, i (id)}
					<div class="target-row">
						<span><code>{slugOf(id)}</code></span>
						{#if statusOf(id) in WARNING_TARGET_STATUSES}
							<Badge tone="warning">{statusOf(id)}</Badge>
						{/if}
						<span class="fr-actions">
							<Button size="sm" onclick={() => (newTargets = swap(newTargets, i + 1, i))} {pending}>
								Move up
							</Button>
							<Button
								size="sm"
								onclick={() => (newTargets = swap(newTargets, i + 1, i + 2))}
								{pending}
							>
								Move down
							</Button>
							<Button
								size="sm"
								variant="danger"
								onclick={() => (newTargets = newTargets.filter((t) => t !== id))}
								{pending}
							>
								Remove
							</Button>
						</span>
					</div>
				{/each}
			</div>
		{/if}
		<Field label="Add fallback" hint="Tried in order when the model above is unavailable.">
			<Select
				value=""
				onchange={handleSelect((v) => (newTargets = addFallback(newTargets, v)))}
			>
				<option value="">Choose a model…</option>
				{#each data.models as m (m.id)}
					<option value={m.id} disabled={newTargets.includes(m.id)}>
						{m.slug}{m.developer ? ` — ${m.developer}` : ''}
					</option>
				{/each}
			</Select>
		</Field>
		<input type="hidden" name="targets" value={JSON.stringify(newTargets)} />
		<Button type="submit" variant="primary" {pending} disabled={newTargets.length === 0}>
			Create alias
		</Button>
	</form>
	<CodeBlock label="What your app sends" code={'{\n  "model": "<name>"\n}'} />
	<p class="muted">
		The alias name is stable: you can reorder or replace its targets here and the change reaches
		your users on the next request — no redeploy needed.
	</p>
</Card>

{#if editing}
	<Card>
		<h2>Edit alias: {editing.name}</h2>
		<form method="POST" action="?/update" use:enhance={track} class="stack">
			<input type="hidden" name="id" value={editing.id} />
			<Field label="Name" hint="2–64 characters: lowercase letters, digits and dashes.">
				<Input name="name" bind:value={editName} required />
			</Field>
			<Field label="Description">
				<Textarea name="description" rows="2" bind:value={editDescription}></Textarea>
			</Field>
			<Field label="Scope">
				<Select
					name="scope"
					value={editScope}
					onchange={handleSelect((v) => (editScope = v === 'workspace' ? 'workspace' : 'project'))}
				>
					<option value="project">project</option>
					<option value="workspace">workspace</option>
				</Select>
			</Field>
			<label class="check">
				<input type="checkbox" name="enabled" value="yes" bind:checked={editEnabled} />
				Enabled
			</label>
			<Field label="Primary model">
				<Select
					value={editTargets[0] ?? ''}
					onchange={handleSelect((v) => (editTargets = setPrimary(editTargets, v)))}
				>
					<option value="">Choose a model…</option>
					{#each data.models as m (m.id)}
						<option value={m.id} disabled={editTargets.includes(m.id) && editTargets[0] !== m.id}>
							{m.slug}
						</option>
					{/each}
				</Select>
			</Field>
			{#if editTargets.length > 1}
				<div class="stack">
					<span class="fr-label">Fallbacks</span>
					{#each editTargets.slice(1) as id, i (id)}
						<div class="target-row">
							<span><code>{slugOf(id)}</code></span>
							{#if statusOf(id) in WARNING_TARGET_STATUSES}
								<Badge tone="warning">{statusOf(id)}</Badge>
							{/if}
							<span class="fr-actions">
								<Button size="sm" onclick={() => (editTargets = swap(editTargets, i + 1, i))} {pending}>
									Move up
								</Button>
								<Button
									size="sm"
									onclick={() => (editTargets = swap(editTargets, i + 1, i + 2))}
									{pending}
								>
									Move down
								</Button>
								<Button
									size="sm"
									variant="danger"
									onclick={() => (editTargets = editTargets.filter((t) => t !== id))}
									{pending}
								>
									Remove
								</Button>
							</span>
						</div>
					{/each}
				</div>
			{/if}
			<Field label="Add fallback">
				<Select value="" onchange={handleSelect((v) => (editTargets = addFallback(editTargets, v)))}>
					<option value="">Choose a model…</option>
					{#each data.models as m (m.id)}
						<option value={m.id} disabled={editTargets.includes(m.id)}>
							{m.slug}
						</option>
					{/each}
				</Select>
			</Field>
			{#each editTargets as id (id)}
				{#if statusOf(id) in WARNING_TARGET_STATUSES}
					<Alert tone="warning">
						Target <code>{slugOf(id)}</code> is {statusOf(id)} — plan a migration off it.
					</Alert>
				{/if}
			{/each}
			<input type="hidden" name="targets" value={JSON.stringify(editTargets)} />
			<span class="fr-actions">
				<Button type="submit" variant="primary" {pending} disabled={editTargets.length === 0}>
					Save alias
				</Button>
				<Button onclick={() => (editing = null)} {pending}>Cancel</Button>
			</span>
		</form>
	</Card>
{/if}

<DataTable
	caption="Model aliases"
	rows={data.aliases}
	{columns}
	keyOf={(row) => row.id}
	filters={[
		{
			key: 'scope',
			label: 'Scope',
			options: [
				{ value: 'project', label: 'Project' },
				{ value: 'workspace', label: 'Workspace' },
				{ value: 'global', label: 'Global' }
			]
		}
	]}
	empty={{ title: 'No aliases yet', hint: 'Create one above to give your app a stable model name.' }}
>
	{#snippet rowActions(row: AliasRow)}
		<span class="fr-actions">
			{#if row.scope === 'global'}
				<Badge>global</Badge>
			{:else}
				<Badge tone={row.scope === 'workspace' ? 'info' : 'success'}>{row.scope}</Badge>
			{/if}
			{#each flagged(row) as t (t.modelId)}
				<Badge tone="warning">{t.status}: {t.slug}</Badge>
			{/each}
			{#if row.scope !== 'global'}
				<Button size="sm" onclick={() => startEdit(row)} {pending}>Edit</Button>
				<Button size="sm" variant="danger" onclick={() => { deleteTarget = row; confirmOpen = true; }} {pending}>
					Delete
				</Button>
			{/if}
		</span>
	{/snippet}
</DataTable>

<form method="POST" action="?/delete" use:enhance={track} bind:this={deleteForm} class="sr-only">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
	<Button type="submit" {pending}>Delete alias</Button>
</form>
<ConfirmDialog
	bind:open={confirmOpen}
	title="Delete alias?"
	body={deleteTarget ? `“${deleteTarget.name}” stops resolving for every app that sends it.` : ''}
	typed={deleteTarget?.name ?? null}
	danger
	confirmLabel="Delete alias"
	onconfirm={() => deleteForm?.requestSubmit()}
	oncancel={() => (deleteTarget = null)}
/>

<style>
	.target-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: center;
		justify-content: space-between;
		padding: var(--space-xs) 0;
		border-bottom: 1px solid var(--color-border);
	}
	.check {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
	}
</style>
