<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		Field,
		Guide,
		Input,
		PageHeader,
		Select
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<PageHeader
	title="Workspace Settings"
	lede="Rename the workspace, hand it to another member, or close it down."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.renamed}
	<div class="fr-feedback"><Alert tone="success">Workspace renamed to {form.renamed}.</Alert></div>
{/if}
{#if form?.transferred}
	<div class="fr-feedback"><Alert tone="success">Ownership transferred.</Alert></div>
{/if}
{#if form?.archived}
	<div class="fr-feedback"><Alert tone="success">Workspace archived.</Alert></div>
{/if}
{#if form?.restored}
	<div class="fr-feedback"><Alert tone="success">Workspace restored.</Alert></div>
{/if}

<Guide id="workspace" />

<div class="narrow">
	<Card>
		<h2>General</h2>
		<dl class="facts">
			<dt>Slug</dt>
			<dd><code>{data.workspace.slug}</code></dd>
			<dt>Status</dt>
			<dd><Badge tone={data.workspace.status === 'active' ? 'success' : 'warning'}>{data.workspace.status}</Badge></dd>
			<dt>Owner</dt>
			<dd>{data.owner ? `${data.owner.name} (${data.owner.email})` : '—'}</dd>
			<dt>Projects</dt>
			<dd>{data.projectCount}</dd>
			<dt>Members</dt>
			<dd>{data.memberCount}</dd>
		</dl>
		<form method="POST" action="?/rename" use:enhance={track} class="stack">
			<Field label="Workspace name">
				<Input name="name" value={data.workspace.name} required />
			</Field>
			<Button type="submit" {pending}>Rename</Button>
		</form>
	</Card>

	{#if data.isOwner}
		<Card>
			<h2>Transfer ownership</h2>
			<p class="muted">
				The new owner gets the <code>owner</code> role; you step down to <code>admin</code>.
			</p>
			{#if data.members.length}
				<form method="POST" action="?/transfer" use:enhance={track} class="stack">
					<Field label="New owner" hint="Only active members can own the workspace.">
						<Select name="newOwnerId" required>
							{#each data.members as m (m.userId)}
								<option value={m.userId}>{m.name} ({m.email})</option>
							{/each}
						</Select>
					</Field>
					<Button type="submit" {pending}>Transfer ownership</Button>
				</form>
			{:else}
				<p class="muted">Invite a member first — a workspace cannot be handed to a non-member.</p>
			{/if}
		</Card>
	{/if}

	<Card>
		<h2>Archive</h2>
		<p class="muted">Archiving keeps all data but stops new work. You can restore any time.</p>
		{#if data.workspace.status === 'active'}
			<form method="POST" action="?/archive" use:enhance={track}>
				<Button type="submit" variant="danger" {pending}>Archive workspace</Button>
			</form>
		{:else}
			<form method="POST" action="?/restore" use:enhance={track}>
				<Button type="submit" {pending}>Restore workspace</Button>
			</form>
		{/if}
	</Card>

	{#if data.isOwner}
		<Card>
			<h2>Delete workspace</h2>
			<p class="muted">
				Permanently deletes this workspace, its projects, environments and keys. Usage history
				stays in the ledger, anonymised. This cannot be undone.
			</p>
			<form method="POST" action="?/delete" use:enhance={track} class="stack">
				<Field label={`Type “${data.workspace.name}” to confirm`} hint="Exact name, including case.">
					<Input name="confirm" autocomplete="off" required />
				</Field>
				{#if data.projectCount > 0}
					<label class="check">
						<input type="checkbox" name="force" value="yes" />
						Force: delete even though {data.projectCount} project(s) still exist
					</label>
				{/if}
				<Button type="submit" variant="danger" {pending}>Delete workspace</Button>
			</form>
		</Card>
	{/if}
</div>

<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-xs) var(--space-md);
		margin: var(--space-md) 0 0;
	}
	dt {
		color: var(--color-text-muted);
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
