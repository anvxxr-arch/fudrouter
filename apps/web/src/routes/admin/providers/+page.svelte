<script lang="ts">
	import { resolve } from '$app/paths';
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
		Textarea,
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
	const statusTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		operational: 'success',
		degraded: 'warning',
		maintenance: 'neutral',
		disabled: 'neutral',
		outage: 'danger'
	};
</script>

<PageHeader
	title="Providers"
	lede="Upstream vendors fudrouter can route to. Endpoints and credentials live on each provider's connections."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Provider “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Provider saved.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Provider deleted.</Alert></div>
{/if}

<Card>
	<h2 class="first">Add provider</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="xAI" required /></Field>
			<Field label="Slug"><Input name="slug" placeholder="xai" required /></Field>
			<Field label="Type"><Input name="type" placeholder="openai-compatible" /></Field>
			<Field label="Status">
				<Select name="status">
					{#each data.statuses as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Tier">
				<Select name="tier">
					{#each data.tiers as t (t)}<option value={t}>{t}</option>{/each}
				</Select>
			</Field>
			<Field label="Homepage"><Input name="homepage" placeholder="https://x.ai" /></Field>
			<Field label="Docs URL"
				><Input name="documentationUrl" placeholder="https://docs.x.ai"
			/></Field>
			<Field label="Priority"><Input name="priority" type="number" value="100" /></Field>
			<Field label="Enabled"><Input name="enabled" type="checkbox" checked /></Field>
		</div>
		<Field label="Description"><Textarea name="description" rows="2"></Textarea></Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create provider</Button>
		</div>
	</form>
</Card>

<Guide id="admin-providers" />

<TableWrap label="Providers">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Slug</th><th>Type</th><th>Status</th><th>Tier</th><th>Enabled</th>
				<th>Priority</th><th>Models</th><th>Connections</th><th>Credentials</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.providers as p (p.id)}
				<tr>
					<td><a href={resolve('/admin/providers/[id]', { id: p.id })}>{p.name}</a></td>
					<td><code>{p.slug ?? '—'}</code></td>
					<td>{p.type ?? '—'}</td>
					<td><Badge tone={statusTone[p.status] ?? 'neutral'}>{p.status}</Badge></td>
					<td>{p.tier}</td>
					<td>
						{#if p.enabled}<Badge tone="success">on</Badge>{:else}<Badge tone="neutral">off</Badge>{/if}
					</td>
					<td class="num">{p.priority}</td>
					<td class="num">{p.modelCount}</td>
					<td class="num">{p.connectionCount}</td>
					<td class="num">
						{p.credentials.healthy} healthy / {p.credentials.total}
						{#if p.credentials.bad > 0}<span class="bad">{p.credentials.bad} bad</span>{/if}
						{#if p.credentials.unknown > 0}<span class="muted">{p.credentials.unknown} unknown</span
							>{/if}
					</td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(p.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={p.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete provider {p.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === p.id}
					<tr class="edit-row">
						<td colspan="11">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={p.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={p.name} required /></Field>
									<Field label="Slug"><Input name="slug" value={p.slug ?? ''} required /></Field>
									<Field label="Type"><Input name="type" value={p.type ?? ''} /></Field>
									<Field label="Status">
										<Select name="status">
											{#each data.statuses as s (s)}
												<option value={s} selected={s === p.status}>{s}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Tier">
										<Select name="tier">
											{#each data.tiers as t (t)}
												<option value={t} selected={t === p.tier}>{t}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Homepage"><Input name="homepage" value={p.homepage ?? ''} /></Field>
									<Field label="Docs URL">
										<Input name="documentationUrl" value={p.documentationUrl ?? ''} />
									</Field>
									<Field label="Priority"><Input name="priority" type="number" value={p.priority} /></Field>
									<Field label="Enabled"><Input name="enabled" type="checkbox" checked={p.enabled} /></Field>
								</div>
								<Field label="Description">
									<Textarea name="description" rows="2">{p.description ?? ''}</Textarea>
								</Field>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save provider {p.name}">
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
				<tr><td colspan="11"><EmptyState title="No providers yet" /></td></tr>
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
</style>
