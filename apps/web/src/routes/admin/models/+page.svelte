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
		Select
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
	title="Models"
	lede="The catalog your clients can call. Prices are USD per 1M tokens, stored as exact micro-units."
/>

{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Model “{form.created}” created.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Model deleted.</Alert></div>
{/if}

<Card>
	<h2 class="first">Add model</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Provider">
				<Select name="providerId" required>
					{#each data.providers as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Display name"><Input name="name" placeholder="Grok 4.6" required /></Field>
			<Field label="Slug"><Input name="slug" placeholder="grok-4.6" required /></Field>
			<Field label="Context"><Input name="context" type="number" placeholder="128000" /></Field>
			<Field label="Input USD / 1M">
				<Input name="inputUsd" type="number" step="0.0001" placeholder="2.00" required />
			</Field>
			<Field label="Output USD / 1M">
				<Input name="outputUsd" type="number" step="0.0001" placeholder="6.00" required />
			</Field>
			<Field label="Currency"><Input name="currency" value="USD" maxlength="3" /></Field>
			<Field label="Status">
				<Select name="status">
					{#each data.statuses as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create model</Button>
		</div>
	</form>
</Card>

<div class="table-wrap">
<table class="fr">
	
		<thead>
			<tr>
				<th>Slug</th><th>Name</th><th>Provider</th><th>Context</th><th>In / 1M</th><th>Out / 1M</th>
				<th>Status</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.models as m (m.id)}
				<tr>
					<td><code>{m.slug}</code></td>
					<td>{m.name}</td>
					<td>{m.providerName}</td>
					<td class="num">{m.context ?? '—'}</td>
					<td class="num">${m.inputUsd}</td>
					<td class="num">${m.outputUsd}</td>
					<td><Badge tone={m.status === 'active' ? 'success' : 'warning'}>{m.status}</Badge></td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(m.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={m.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete model {m.slug}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === m.id}
					<tr class="edit-row">
						<td colspan="8">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={m.id} />
								<div class="fr-grid">
									<Field label="Input USD / 1M">
										<Input name="inputUsd" type="number" step="0.0001" value={m.inputUsd} />
									</Field>
									<Field label="Output USD / 1M">
										<Input name="outputUsd" type="number" step="0.0001" value={m.outputUsd} />
									</Field>
									<Field label="Context">
										<Input name="context" type="number" value={m.context ?? ''} />
									</Field>
									<Field label="Status">
										<Select name="status">
											{#each data.statuses as s (s)}
												<option value={s} selected={s === m.status}>{s}</option>
											{/each}
										</Select>
									</Field>
								</div>
								<div class="submit">
									<Button
										type="submit"
										{pending}
										variant="primary"
										aria-label="Save model {m.slug}"
									>
										Save
									</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="8"><EmptyState title="No models" /></td></tr>
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
