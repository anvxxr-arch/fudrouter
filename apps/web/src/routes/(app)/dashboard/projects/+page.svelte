<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		TableWrap,
		Textarea,
		ButtonLink
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatDate } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Projects"
	lede="Projects group environments, keys and usage. Create one, then switch the shell into it."
>
	{#snippet actions()}
		<ButtonLink href="/dashboard/projects/new" variant="primary">New project</ButtonLink>
	{/snippet}
</PageHeader>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.archived}
	<div class="fr-feedback"><Alert tone="success">Project “{form.archived}” archived.</Alert></div>
{/if}
{#if form?.restored}
	<div class="fr-feedback"><Alert tone="success">Project “{form.restored}” restored.</Alert></div>
{/if}
<div class="narrow">
	<Card>
		<h2>Create a project</h2>
		<form method="POST" action="?/create" use:enhance={track} class="stack">
			<Field label="Project name" hint="Something you will recognise later, e.g. Prod backend.">
				<Input name="name" placeholder="Prod backend" required />
			</Field>
			<Field label="Description" hint="Optional. What this project is for.">
				<Textarea name="description" rows="2"></Textarea>
			</Field>
			<Button type="submit" variant="primary" {pending}>Create project</Button>
		</form>
	</Card>
</div>
<Guide id="projects" />
<h2>All projects</h2>
<TableWrap label="Projects">
	<table class="fr">
		<thead>
			<tr><th>Name</th><th>Slug</th><th>Status</th><th>Created</th><th>Description</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.projects as p (p.id)}
				<tr>
					<td><a href="/dashboard/projects/{p.id}">{p.name}</a></td>
					<td><code>{p.slug}</code></td>
					<td>
						<Badge tone={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge>
					</td>
					<td class="num">{formatDate(p.createdAt)}</td>
					<td>{p.description ?? '—'}</td>
					<td class="fr-actions">
						<form method="POST" action="?/switch" use:enhance={track}>
							<input type="hidden" name="projectId" value={p.id} />
							<Button type="submit" {pending} aria-label="Switch shell to project {p.name}">Switch</Button>
						</form>
						{#if p.status === 'active'}
							<form method="POST" action="?/archive" use:enhance={track}>
								<input type="hidden" name="projectId" value={p.id} />
								<Button type="submit" variant="danger" {pending} aria-label="Archive project {p.name}">
									Archive
								</Button>
							</form>
						{:else}
							<form method="POST" action="?/restore" use:enhance={track}>
								<input type="hidden" name="projectId" value={p.id} />
								<Button type="submit" {pending} aria-label="Restore project {p.name}">Restore</Button>
							</form>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="6"><EmptyState title="No projects yet" hint="Create one above." /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
</style>
