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
		Guide,
		Input,
		PageHeader,
		Select,
		TableWrap,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatDateTime } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	const healthTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		healthy: 'success',
		degraded: 'warning',
		unhealthy: 'danger',
		unknown: 'neutral'
	};
</script>

<PageHeader
	title="Connections — {data.provider.name}"
	lede="Endpoints this provider is reached through, with their auth shape and health."
/>
<p class="muted">
	<a href={resolve('/admin/providers/[id]', { id: data.provider.id })}>← {data.provider.name}</a>
</p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback">
		<Alert tone="success">Connection “{form.created}” created.</Alert>
	</div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Connection saved.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Connection deleted.</Alert></div>
{/if}

<Card>
	<h2 class="first">Add connection</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="us-east primary" required /></Field>
			<Field label="Slug" hint="Unique within this provider.">
				<Input name="slug" placeholder="us-east" required />
			</Field>
			<Field label="Base URL"><Input name="baseUrl" placeholder="https://host/v1" required /></Field>
			<Field label="Region"><Input name="region" placeholder="us-east-1" /></Field>
			<Field label="Auth type">
				<Select name="authType">
					{#each data.authTypes as t (t)}<option value={t}>{t}</option>{/each}
				</Select>
			</Field>
			<Field label="Timeout (ms)"><Input name="timeoutMs" type="number" value="120000" /></Field>
			<Field label="Priority"><Input name="priority" type="number" value="100" /></Field>
			<Field label="Enabled"><Input name="enabled" type="checkbox" checked /></Field>
		</div>
		<Field label="Config (JSON)" hint={'Object only, e.g. {"pool": 4}.'}>
			<Textarea name="config" rows="2" placeholder={'{}'}></Textarea>
		</Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create connection</Button>
		</div>
	</form>
</Card>

<Guide id="admin-provider-connections" />

<TableWrap label="Connections">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Slug</th><th>Base URL</th><th>Region</th><th>Auth</th><th>Health</th>
				<th>Enabled</th><th>Priority</th><th>Credentials</th><th>Updated</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.connections as c (c.id)}
				<tr>
					<td>{c.name}</td>
					<td><code>{c.slug}</code></td>
					<td><code>{c.baseUrl}</code></td>
					<td>{c.region ?? '—'}</td>
					<td>{c.authType}</td>
					<td><Badge tone={healthTone[c.healthStatus] ?? 'neutral'}>{c.healthStatus}</Badge></td>
					<td>
						{#if c.enabled}<Badge tone="success">on</Badge>{:else}<Badge tone="neutral">off</Badge>{/if}
					</td>
					<td class="num">{c.priority}</td>
					<td class="num">{c.credentialHealthy}/{c.credentialCount} healthy</td>
					<td class="num">{formatDateTime(c.updatedAt)}</td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(c.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete connection {c.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === c.id}
					<tr class="edit-row">
						<td colspan="11">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={c.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={c.name} required /></Field>
									<Field label="Slug"><Input name="slug" value={c.slug} required /></Field>
									<Field label="Base URL"><Input name="baseUrl" value={c.baseUrl} required /></Field>
									<Field label="Region"><Input name="region" value={c.region ?? ''} /></Field>
									<Field label="Auth type">
										<Select name="authType">
											{#each data.authTypes as t (t)}
												<option value={t} selected={t === c.authType}>{t}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Timeout (ms)">
										<Input name="timeoutMs" type="number" value={c.timeoutMs} />
									</Field>
									<Field label="Priority"><Input name="priority" type="number" value={c.priority} /></Field>
									<Field label="Enabled">
										<Input name="enabled" type="checkbox" checked={c.enabled} />
									</Field>
								</div>
								<Field label="Config (JSON)">
									<Textarea name="config" rows="2">{JSON.stringify(c.config)}</Textarea>
								</Field>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save connection {c.name}">
										Save
									</Button>
								</div>
							</form>
							<p class="muted">Added {formatDateTime(c.createdAt)}.</p>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="11"><EmptyState title="No connections yet" /></td></tr>
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
