<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Button,
		Card,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Project Settings"
	lede="Rename the project, move its slug, or close it down."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.saved}<div class="fr-feedback"><Alert tone="success">Settings saved.</Alert></div>{/if}
<div class="narrow">
	<Card>
		<h2>General</h2>
		<form method="POST" action="?/update" use:enhance={track} class="stack">
			<Field label="Project name">
				<Input name="name" value={data.project.name} required />
			</Field>
			<Field label="Slug" hint="URL-safe and unique per workspace.">
				<Input name="slug" value={data.project.slug} required />
			</Field>
			<Field label="Description">
				<Textarea name="description" rows="3" value={data.project.description ?? ''}></Textarea>
			</Field>
			<Field label="Status" hint="Archived projects keep their data but stop new work.">
				<Select name="status" value={data.project.status}>
					{#each data.statuses as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</Select>
			</Field>
			<Button type="submit" variant="primary" {pending}>Save settings</Button>
		</form>
	</Card>
	<Card>
		<h2>Delete project</h2>
		<p class="muted">
			Permanently deletes this project, its environments and its API keys. Usage history stays in
			the ledger, anonymised. This cannot be undone.
		</p>
		<form method="POST" action="?/delete" use:enhance={track} class="stack">
			<Field label={`Type “${data.project.name}” to confirm`} hint="Exact name, including case.">
				<Input name="confirm" autocomplete="off" required />
			</Field>
			<label class="check">
				<input type="checkbox" name="force" value="yes" />
				Force: delete even though API keys still exist
			</label>
			<Button type="submit" variant="danger" {pending}>Delete project</Button>
		</form>
	</Card>
</div>
<Guide id="project" />
<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.check {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--color-text-muted);
	}
</style>
