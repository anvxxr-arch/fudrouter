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
		Select,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	function connsOf(providerId: string) {
		return data.connections.filter((c: { providerId: string }) => c.providerId === providerId);
	}
</script>
<PageHeader
	title="Model mappings"
	lede="Which upstream model serves a canonical model. One canonical model can map to many providers."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}
<Guide id="admin-model-mappings" />
<Card>
	<h2 class="first">Add mapping</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Canonical model">
				<Select name="modelId" required>
					{#each data.models as m (m.id)}<option value={m.id}>{m.slug}</option>{/each}
				</Select>
			</Field>
			<Field label="Provider">
				<Select name="providerId" required>
					{#each data.providers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</Select>
			</Field>
			<Field label="Upstream model id"><Input name="providerModelId" required /></Field>
			<Field label="Context override" hint="Empty inherits the canonical context">
				<Input name="contextOverride" type="number" />
			</Field>
			<Field label="Capabilities override (JSON flags)">
				<Input name="capabilitiesOverride" placeholder={'{"tools": true}'} />
			</Field>
		</div>
		<label class="muted"><input type="checkbox" name="enabled" checked /> enabled</label>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create mapping</Button>
		</div>
	</form>
</Card>
<Card>
	<h2 class="first">All mappings</h2>
	<TableWrap label="Model mappings">
		<table class="fr">
			<thead>
				<tr>
					<th>Model</th><th>Provider</th><th>Connection</th><th>Upstream id</th><th
						>Context override</th
					><th>Capabilities override</th><th>Status</th><th>Enabled</th><th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as row (row.id)}
					<tr>
						<td><code>{row.modelSlug}</code></td>
						<td>{row.providerName}</td>
						<td>{row.connectionName ?? 'any'}</td>
						<td><code>{row.providerModelId}</code></td>
						<td class="num">{row.contextOverride ?? '—'}</td>
						<td>
							{#if Object.keys(row.capabilitiesOverride).length === 0}
								<span class="muted">inherit</span>
							{:else}
								<code>{JSON.stringify(row.capabilitiesOverride)}</code>
							{/if}
						</td>
						<td><Badge tone={row.status === 'available' ? 'success' : 'neutral'}>{row.status}</Badge></td>
						<td>{row.enabled ? 'enabled' : 'disabled'}</td>
						<td class="fr-actions">
							<Button type="button" onclick={() => toggle(row.id)}>Edit</Button>
							<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
								<input type="hidden" name="id" value={row.id} />
								<Button
									type="submit"
									{pending}
									variant="danger"
									aria-label="Delete mapping {row.providerModelId}"
								>
									Delete
								</Button>
							</form>
						</td>
					</tr>
					{#if editing === row.id}
						<tr class="edit-row">
							<td colspan="9">
								<form method="POST" action="?/update" use:enhance={track}>
									<input type="hidden" name="id" value={row.id} />
									<div class="fr-grid">
										<Field label="Upstream model id">
											<Input name="providerModelId" value={row.providerModelId} required />
										</Field>
										<Field label="Connection">
											<Select name="connectionId">
												<option value="">any</option>
												{#each connsOf(row.providerId) as c (c.id)}
													<option value={c.id} selected={c.id === row.connectionId}>
														{c.name}{c.region ? ` (${c.region})` : ''}
													</option>
												{/each}
											</Select>
										</Field>
										<Field label="Context override">
											<Input name="contextOverride" type="number" value={row.contextOverride ?? ''} />
										</Field>
										<Field label="Capabilities override (JSON flags)">
											<Input
												name="capabilitiesOverride"
												value={JSON.stringify(row.capabilitiesOverride)}
											/>
										</Field>
										<Field label="Status">
											<Select name="status">
												{#each data.statuses as s (s)}
													<option value={s} selected={s === row.status}>{s}</option>
												{/each}
											</Select>
										</Field>
										<Field label="Enabled">
											<Select name="enabled">
												<option value="on" selected={row.enabled}>enabled</option>
												<option value="" selected={!row.enabled}>disabled</option>
											</Select>
										</Field>
									</div>
									<div class="submit">
										<Button type="submit" {pending} variant="primary">Save</Button>
									</div>
								</form>
							</td>
						</tr>
					{/if}
				{:else}
					<tr><td colspan="9"><EmptyState title="No mappings yet" hint="Add one above." /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>
<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
</style>
