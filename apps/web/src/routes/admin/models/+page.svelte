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

	// Checkbox selection. The boxes live inside the table but belong to the
	// toolbar form (HTML `form=` attribute) — a form may not nest, and every row
	// already carries its own edit/delete form.
	let selected = $state<string[]>([]);
	const visibleIds = $derived(data.models.map((m: { id: string }) => m.id));
	function selectAll() {
		selected = [...visibleIds];
	}
	function selectNone() {
		selected = [];
	}

	const stateLabels: Record<string, string> = {
		unpublished: 'not published',
		'provider-off': 'provider off'
	};
</script>

<PageHeader
	title="Models"
	lede="What clients can call. Publishing is the switch — a model must be published and its provider live before the router serves it."
/>

{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Model “{form.created}” created.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Model deleted.</Alert></div>
{/if}

<Card>
	<h2 class="first">Publish state</h2>
	<p class="muted">
		{data.counts.published} of {data.counts.all} models are published, and {data.counts.served} are actually
		reachable{#if data.counts.published > data.counts.served}
			— {data.counts.published - data.counts.served} are published but held back by their provider{:else}.{/if}
	</p>
	{#if !data.allowDev}
		<div class="fr-feedback">
			<Alert tone="warning">
				Dev providers are switched off on the router (<code>ROUTER_ALLOW_DEV_PROVIDERS</code>), so
				models on a <strong>dev</strong> provider stay unreachable however they are published.
			</Alert>
		</div>
	{/if}
	<TableWrap label="Models per provider">
		<table class="fr">
			<thead>
				<tr>
					<th>Provider</th><th>Provider status</th><th>Models</th><th>Published</th><th>Live</th><th
						>Whole provider</th
					>
				</tr>
			</thead>
			<tbody>
				{#each data.summary as p (p.id)}
					<tr>
						<td>{p.name}</td>
						<td><Badge tone={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge></td>
						<td class="num">{p.total}</td>
						<td class="num">{p.published}</td>
						<td class="num">{p.served}</td>
						<td class="fr-actions">
							{#if p.total > 0}
								<form method="POST" action="?/provider" use:enhance={track} class="fr-inline">
									<input type="hidden" name="providerId" value={p.id} />
									<Button
										type="submit"
										name="status"
										value="active"
										{pending}
										aria-label="Publish every model on {p.name}"
									>
										Publish all
									</Button>
									<Button
										type="submit"
										name="status"
										value="disabled"
										{pending}
										aria-label="Unpublish every model on {p.name}"
									>
										Unpublish all
									</Button>
								</form>
							{:else}
								<span class="muted">—</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>

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

<Guide id="admin-models" />

<Card>
	<h2 class="first">Catalog</h2>

	<form method="GET" class="filters">
		<Field label="Provider">
			<Select name="provider">
				<option value="" selected={!data.providerFilter}>All providers</option>
				{#each data.providers as p (p.id)}
					<option value={p.id} selected={p.id === data.providerFilter}>{p.name}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Reachability">
			<Select name="state">
				<option value="all" selected={data.stateFilter === 'all'}>All</option>
				<option value="served" selected={data.stateFilter === 'served'}>Live only</option>
				<option value="hidden" selected={data.stateFilter === 'hidden'}>Hidden only</option>
			</Select>
		</Field>
		<div class="submit"><Button type="submit">Apply</Button></div>
	</form>

	<p class="muted">
		Showing {data.models.length} of {data.counts.all} — {data.counts.served} live, {data.counts
			.hidden}
		hidden.
	</p>

	<!-- The toolbar form. Checkboxes in the table reference it by id. -->
	<form id="bulk" method="POST" action="?/bulk" use:enhance={track} class="bulk">
		<span class="muted">{selected.length} selected</span>
		<Button type="button" onclick={selectAll} disabled={visibleIds.length === 0}>Select all</Button>
		<Button type="button" onclick={selectNone} disabled={selected.length === 0}>Clear</Button>
		<Button type="submit" name="status" value="active" {pending} disabled={selected.length === 0}>
			Publish selected
		</Button>
		<Button type="submit" name="status" value="disabled" {pending} disabled={selected.length === 0}>
			Unpublish selected
		</Button>
	</form>

	<TableWrap label="Catalog">
		<table class="fr">
			<thead>
				<tr>
					<th><span class="sr-only">Select</span></th>
					<th>Slug</th><th>Name</th><th>Provider</th><th>Context</th><th>In / 1M</th><th
						>Out / 1M</th
					><th>Publish</th><th>Reachable</th><th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.models as m (m.id)}
					<tr>
						<td>
							<input
								type="checkbox"
								name="ids"
								value={m.id}
								form="bulk"
								bind:group={selected}
								aria-label="Select model {m.slug}"
							/>
						</td>
						<td><code>{m.slug}</code></td>
						<td>{m.name}</td>
						<td>{m.providerName}</td>
						<td class="num">{m.context ?? '—'}</td>
						<td class="num">${m.inputUsd}</td>
						<td class="num">${m.outputUsd}</td>
						<td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{m.status}</Badge></td>
						<td>
							{#if m.served}
								<Badge tone="success">live</Badge>
							{:else}
								<Badge tone="warning"
									>{m.hiddenReason ? stateLabels[m.hiddenReason] : 'hidden'}</Badge
								>
							{/if}
						</td>
						<td class="fr-actions">
							<form method="POST" action="?/bulk" use:enhance={track} class="fr-inline">
								<input type="hidden" name="ids" value={m.id} />
								{#if m.status === 'active'}
									<Button
										type="submit"
										name="status"
										value="disabled"
										{pending}
										aria-label="Unpublish model {m.slug}"
									>
										Unpublish
									</Button>
								{:else}
									<Button
										type="submit"
										name="status"
										value="active"
										{pending}
										variant="primary"
										aria-label="Publish model {m.slug}"
									>
										Publish
									</Button>
								{/if}
							</form>
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
							<td colspan="10">
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
					<tr><td colspan="10"><EmptyState title="No models match this filter" /></td></tr>
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
		gap: var(--fr-space-md);
	}
	.filters {
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		align-items: end;
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		gap: var(--fr-space-sm);
		align-items: center;
		margin-block: var(--fr-space-md);
	}
	.bulk .muted {
		margin-right: auto;
	}
</style>
