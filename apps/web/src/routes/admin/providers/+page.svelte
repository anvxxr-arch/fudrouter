<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Input,
		PageHeader,
		Guide,
		Select,
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
	title="Providers"
	lede="Upstream endpoints fudrouter can route to. Credentials are encrypted at rest and never shown again."
/>

{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Provider “{form.created}” created.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Provider deleted.</Alert></div>
{/if}

<Card>
	<h2 class="first">Add provider</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="xai-grok" required /></Field>
			<Field label="Base URL"><Input name="baseUrl" placeholder="https://host/v1" required /></Field
			>
			<Field label="API key"
				><Input name="apiKey" type="password" placeholder="upstream secret" required /></Field
			>
			<Field label="Status">
				<Select name="status">
					{#each data.statuses as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Priority"><Input name="priority" type="number" value="100" /></Field>
		</div>
		<Field label="Default headers" hint="One per line, Name: value.">
			<Textarea name="headers" rows="2" placeholder="x-grok-client-version: 0.1.0"></Textarea>
		</Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create provider</Button>
		</div>
	</form>
</Card>

<Guide id="admin-providers" />

<div class="table-wrap">
<table class="fr">
	
		<thead>
			<tr
				><th>Name</th><th>Base URL</th><th>Status</th><th>Priority</th><th>Models</th><th
					>Actions</th
				></tr
			>
		</thead>
		<tbody>
			{#each data.providers as p (p.id)}
				<tr>
					<td>{p.name}</td>
					<td><code>{p.baseUrl}</code></td>
					<td><Badge tone={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge></td>
					<td class="num">{p.priority}</td>
					<td class="num">{p.modelCount}</td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(p.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={p.id} />
							<Button
								type="submit"
								{pending}
								variant="danger"
								aria-label="Delete provider {p.name}"
							>
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === p.id}
					<tr class="edit-row">
						<td colspan="6">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={p.id} />
								<div class="fr-grid">
									<Field label="Base URL"><Input name="baseUrl" value={p.baseUrl} /></Field>
									<Field label="Status">
										<Select name="status">
											{#each data.statuses as s (s)}
												<option value={s} selected={s === p.status}>{s}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Priority"
										><Input name="priority" type="number" value={p.priority} /></Field
									>
									<Field label="New API key" hint="Leave blank to keep the current one.">
										<Input name="apiKey" type="password" />
									</Field>
								</div>
								<Field label="Default headers" hint="Replaces existing headers when a key is set.">
									<Textarea name="headers" rows="2"></Textarea>
								</Field>
								<div class="submit">
									<Button
										type="submit"
										{pending}
										variant="primary"
										aria-label="Save provider {p.name}"
									>
										Save
									</Button>
								</div>
							</form>
							<p class="muted">
								Models: {data.models
									.filter((m) => m.providerId === p.id)
									.map((m) => m.slug)
									.join(', ') || '—'}
							</p>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="6"><EmptyState title="No providers yet" /></td></tr>
			{/each}
		</tbody>
	</table></div>

<style>
	
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--fr-space-md);
	}</style>
