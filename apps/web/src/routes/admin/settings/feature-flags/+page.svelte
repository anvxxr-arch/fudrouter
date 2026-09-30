<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
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
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
</script>

<PageHeader
	title="Feature flags"
	lede="Rollout switches read at runtime (PRD §104). Every change is audit-logged."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Feature flag “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">“{form.updated}” saved.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">“{form.deleted}” deleted.</Alert></div>
{/if}
<Guide id="admin-settings-feature-flags" />

<Card>
	<h2 class="first">Add feature flag</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="new_checkout" required /></Field>
			<Field label="Description"><Input name="description" placeholder="What this gates" /></Field>
		</div>
		<Field
			label="Rollout"
			hint="JSON object with your rollout keys. Blank means empty — no rollout claims."
		>
			<Textarea name="rollout" rows="2" placeholder={'{"percent": 25}'}></Textarea>
		</Field>
		<label class="check">
			<input type="checkbox" name="enabled" /> Enabled
		</label>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create flag</Button>
		</div>
	</form>
</Card>

<TableWrap label="Feature flags">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Description</th><th>Rollout</th><th>State</th><th>Updated</th><th
					>Actions</th
				>
			</tr>
		</thead>
		<tbody>
			{#each data.flags as f (f.id)}
				<tr>
					<td><code>{f.name}</code></td>
					<td>{f.description || '—'}</td>
					<td><code>{JSON.stringify(f.rollout)}</code></td>
					<td>
						<Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'on' : 'off'}</Badge>
					</td>
					<td class="num">{formatDateTime(f.updatedAt)}</td>
					<td class="fr-actions">
						<form method="POST" action="?/toggle" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={f.id} />
							<Button
								type="submit"
								{pending}
								aria-label="{f.enabled ? 'Disable' : 'Enable'} flag {f.name}"
							>
								{f.enabled ? 'Disable' : 'Enable'}
							</Button>
						</form>
						<Button type="button" onclick={() => toggle(f.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={f.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete flag {f.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === f.id}
					<tr class="edit-row">
						<td colspan="6">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={f.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={f.name} required /></Field>
									<Field label="Description"
										><Input name="description" value={f.description} /></Field
									>
								</div>
								<Field label="Rollout" hint="JSON object; blank means empty.">
									<Textarea name="rollout" rows="2" value={JSON.stringify(f.rollout)}></Textarea>
								</Field>
								<label class="check">
									<input type="checkbox" name="enabled" checked={f.enabled} /> Enabled
								</label>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save flag {f.name}">
										Save
									</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="6"><EmptyState title="No feature flags yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>

<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
	.check {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}
	.submit {
		display: flex;
		gap: var(--space-md);
	}
</style>
