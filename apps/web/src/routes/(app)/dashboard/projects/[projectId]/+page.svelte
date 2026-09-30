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
	import { formatDate } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const base = $derived(`/dashboard/projects/${data.project.id}`);
</script>
<PageHeader
	title={data.project.name}
	lede="Environments, keys and usage all live under this project."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.renamed}
	<div class="fr-feedback"><Alert tone="success">Project renamed to {form.renamed}.</Alert></div>
{/if}
{#if form?.archived}
	<div class="fr-feedback"><Alert tone="success">Project “{form.archived}” archived.</Alert></div>
{/if}
{#if form?.restored}
	<div class="fr-feedback"><Alert tone="success">Project “{form.restored}” restored.</Alert></div>
{/if}
<div class="narrow">
	<Card>
		<h2>Details</h2>
		<dl class="facts">
			<dt>Slug</dt>
			<dd><code>{data.project.slug}</code></dd>
			<dt>Status</dt>
			<dd>
				<Badge tone={data.project.status === 'active' ? 'success' : 'warning'}>
					{data.project.status}
				</Badge>
			</dd>
			<dt>Created</dt>
			<dd class="num">{formatDate(data.project.createdAt)}</dd>
			<dt>Description</dt>
			<dd>{data.project.description ?? '—'}</dd>
		</dl>
		<form method="POST" action="?/rename" use:enhance={track} class="stack">
			<Field label="Project name">
				<Input name="name" value={data.project.name} required />
			</Field>
			<Button type="submit" {pending}>Rename</Button>
		</form>
	</Card>
	<Card>
		<h2>Sub-pages</h2>
		<ul class="subpages">
			<li><a href="{base}/playground">Playground</a></li>
			<li><a href="{base}/aliases">Model aliases</a></li>
			<li><a href="{base}/routing">Routing policy</a></li>
			<li><a href="{base}/keys">API keys</a></li>
		</ul>
	</Card>
	<Card>
		<h2>Switch shell here</h2>
		<p class="muted">
			Point the header switchers (<code>fpid</code>/<code>feid</code>) at this project and its first
			environment.
		</p>
		<form method="POST" action="?/switch" use:enhance={track}>
			<Button type="submit" {pending}>Switch to this project</Button>
		</form>
	</Card>
	<Card>
		<h2>Archive</h2>
		<p class="muted">Archiving keeps all data but stops new work. You can restore any time.</p>
		{#if data.project.status === 'active'}
			<form method="POST" action="?/archive" use:enhance={track}>
				<Button type="submit" variant="danger" {pending}>Archive project</Button>
			</form>
		{:else}
			<form method="POST" action="?/restore" use:enhance={track}>
				<Button type="submit" {pending}>Restore project</Button>
			</form>
		{/if}
	</Card>
	<Card>
		<h2>Delete project</h2>
		<p class="muted">
			Permanently deletes this project, its environments and its API keys. Usage history stays in
			the ledger, anonymised. This cannot be undone.
		</p>
		<form method="POST" action="?/delete" use:enhance={track} class="stack">
			<Field label={`Type “${data.project.name}” to confirm`} hint="Exact name, including case.">
				<Input name="confirm" autocomplete="off" required />
			</Field>
			<label class="check">
				<input type="checkbox" name="force" value="yes" />
				Force: delete even though API keys still exist
			</label>
			<Button type="submit" variant="danger" {pending}>Delete project</Button>
		</form>
	</Card>
</div>
<Guide id="project" />
<h2>Environments</h2>
<TableWrap label="Environments">
	<table class="fr">
		<thead>
			<tr><th>Name</th><th>Slug</th><th>Type</th><th>Status</th><th>API keys</th></tr>
		</thead>
		<tbody>
			{#each data.environments as e (e.id)}
				<tr>
					<td><a href="{base}/environments">{e.name}</a></td>
					<td><code>{e.slug}</code></td>
					<td>{e.type}</td>
					<td>
						<Badge tone={e.status === 'active' ? 'success' : 'warning'}>{e.status}</Badge>
					</td>
					<td class="num">{e.keyCount}</td>
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
	.subpages {
		display: grid;
		gap: var(--space-sm);
		margin: var(--space-md) 0 0;
		padding: 0;
		list-style: none;
	}
</style>
