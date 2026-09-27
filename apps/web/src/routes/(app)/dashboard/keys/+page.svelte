<script lang="ts">
	import { enhance } from '$app/forms';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { Alert, Badge, Button, Card, EmptyState, Field, Guide, Input, PageHeader, TableWrap } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	// One flag for the page: any in-flight action disables every submit, which also
	// stops a double-click from firing two creates.
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={220} color="#3B82F4" />
</div>
<PageHeader
	title="API Keys"
	lede="Keys authenticate your calls to the router. The secret is shown once, at creation."
/>

{#if form?.created}
	<div class="fr-feedback">
		<Alert tone="success">
			<strong>Key created — copy it now, it is shown once.</strong>
			<code class="secret">{form.created}</code>
			<span>Use it as <code>Authorization: Bearer &lt;key&gt;</code> against the router.</span>
		</Alert>
	</div>
{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}

<!-- Wrapper, not `<Card class="narrow">`: a class passed to a child component lands
     in the child's scope, so the page's own `<style>` rule would not match it. -->
<div class="narrow">
	<Card>
		<form method="POST" action="?/create" use:enhance={track} class="create">
			<Field label="Key name" hint="Something you will recognise later, e.g. prod-backend.">
				<Input name="name" placeholder="prod-backend" required />
			</Field>
			<Button type="submit" variant="primary" {pending}>Create key</Button>
		</form>
	</Card>
</div>

<Guide id="keys" />

<!-- Named: without a heading the table's header row sat directly under the guide's
     last row and the two read as one table. -->
<h2>Your keys</h2>
<TableWrap label="Your keys">
<table class="fr">
	
		<thead>
			<tr><th>Name</th><th>Prefix</th><th>Created</th><th>Status</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.keys as k (k.id)}
				<tr>
					<td>{k.name}</td>
					<td><code>sk-ar-{k.prefix}…</code></td>
					<td class="num">{k.createdAt.toISOString().slice(0, 10)}</td>
					<td>
						<Badge tone={k.revokedAt ? 'danger' : 'success'}>
							{k.revokedAt ? 'revoked' : 'active'}
						</Badge>
					</td>
					<td class="fr-actions">
						{#if !k.revokedAt}
							<form method="POST" action="?/revoke" use:enhance={track}>
								<input type="hidden" name="id" value={k.id} />
								<Button type="submit" variant="danger" {pending} aria-label="Revoke key {k.name}">
									Revoke
								</Button>
							</form>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="5"><EmptyState title="No keys yet" hint="Create one above." /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap>


