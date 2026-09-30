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
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	// Editing target for the one form below: null = create, a role id = update.
	let editingId = $state<string | null>(null);
	const editing = $derived(data.roles.find((r) => r.id === editingId) ?? null);
	// The group checkboxes and the server both read the full pinned code list
	// (`name` = the permission code), so a code is never hand-typed here.
</script>
<PageHeader
	title="Roles"
	lede="Builtin templates are fixed; custom roles are a collection of permission codes."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}<div class="fr-feedback"><Alert tone="success">Role “{form.created}” created.</Alert></div>{/if}
{#if form?.saved}<div class="fr-feedback"><Alert tone="success">Role “{form.saved}” saved.</Alert></div>{/if}
{#if form?.deleted}<div class="fr-feedback"><Alert tone="success">Role “{form.deleted}” deleted.</Alert></div>{/if}
<div class="narrow">
	<Card>
		<h2>{editing ? `Edit “${editing.name}”` : 'New custom role'}</h2>
		<form method="POST" action={editing ? '?/update' : '?/create'} use:enhance={track} class="stack">
			{#if editing}<input type="hidden" name="roleId" value={editing.id} />{/if}
			<Field label="Role name">
				<Input name="name" value={editing ? editing.name : ''} disabled={Boolean(editing)} required />
			</Field>
			{#each data.groups as g (g.prefix)}
				<fieldset class="group">
					<legend class="fr-label">{g.prefix}</legend>
					{#each g.codes as code (code)}
						<label class="check">
							<input type="checkbox" name={code} checked={editing?.permissions.includes(code) ?? false} />
							<code>{code}</code>
						</label>
					{/each}
				</fieldset>
			{/each}
			<div class="rowform">
				<Button type="submit" variant="primary" {pending}>{editing ? 'Save role' : 'Create role'}</Button>
				{#if editing}<Button type="button" {pending} onclick={() => (editingId = null)}>Cancel</Button>{/if}
			</div>
		</form>
	</Card>
</div>
<Guide id="team" />
<h2>Roles</h2>
<TableWrap label="Roles">
	<table class="fr">
		<thead>
			<tr><th>Name</th><th>Kind</th><th>Permissions</th><th>Members</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.roles as r (r.id)}
				<tr>
					<td>{r.name}</td>
					<td><Badge tone={r.custom ? 'info' : 'neutral'}>{r.custom ? 'custom' : 'builtin'}</Badge></td>
					<td class="perms">
						{#each r.permissions as p (p)}<code>{p}</code>{/each}
					</td>
					<td class="num">{r.memberCount}</td>
					<td class="fr-actions">
						{#if r.custom}
							<Button size="sm" {pending} onclick={() => (editingId = r.id)}>Edit</Button>
							<form method="POST" action="?/delete" use:enhance={track} class="rowform">
								<input type="hidden" name="roleId" value={r.id} />
								<Input
									name="confirm"
									size="sm"
									placeholder={r.name}
									aria-label={`Type ${r.name} exactly to confirm deletion`}
									required
								/>
								<Button type="submit" variant="danger" size="sm" {pending} aria-label="Delete role {r.name}">
									Delete
								</Button>
							</form>
						{:else}
							<span class="muted">Template</span>
						{/if}
					</td>
				</tr>
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
	.group {
		display: grid;
		gap: var(--space-xs);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-sm);
	}
	.check {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		font-size: var(--text-sm);
	}
	.rowform {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
		flex-wrap: wrap;
	}
	.perms {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}
	.muted {
		color: var(--color-text-muted);
	}
</style>
