<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { formatDate, formatDateTime } from '$lib/format';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
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
	// One flag for the page: any in-flight action disables every submit, which also
	// stops a double-click from firing two creates.
	let pending = $state(false);
	const track = withPending((v) => (pending = v));

	const statusTone = (s: string) => (s === 'active' ? 'success' : s === 'disabled' ? 'warning' : 'danger');
</script>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={220} color="#3B82F4" />
</div>
<PageHeader
	title="API Keys"
	lede={`Keys for ${data.projectName}. The secret is shown once, at creation.`}
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
{#if form?.enabled}
	<div class="fr-feedback"><Alert tone="success">Key “{form.enabled}” enabled.</Alert></div>
{/if}
{#if form?.disabled}
	<div class="fr-feedback"><Alert tone="success">Key “{form.disabled}” disabled.</Alert></div>
{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}

<!-- Wrapper, not `<Card class="narrow">`: a class passed to a child component lands
     in the child's scope, so the page's own `<style>` rule would not match it. -->
<div class="narrow">
	<Card>
		<h2>Create key</h2>
		<form method="POST" action="?/create" use:enhance={track} class="create">
			<Field label="Key name" hint="Something you will recognise later, e.g. prod-backend.">
				<Input name="name" placeholder="prod-backend" required />
			</Field>
			<Field label="Environment" hint="The environment this key authenticates for.">
				<Select name="environmentId" required>
					{#each data.environments as e (e.id)}
						<option value={e.id}>{e.name}{e.status === 'disabled' ? ' (disabled)' : ''}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Expiration" hint="Optional. Empty = the key never expires.">
				<Input name="expiresAt" type="date" />
			</Field>

			<p class="muted">
				Restrictions are optional. A left-out field inherits the limits of the environment,
				project and workspace — it is not “unlimited”.
			</p>
			<Field label="Allowed endpoints" hint="Comma-separated, e.g. /v1/chat/completions.">
				<Input name="endpoints" placeholder="/v1/chat/completions" />
			</Field>
			<Field label="Allowed models" hint="Comma-separated model slugs.">
				<Input name="models" placeholder="deepseek/deepseek-v4" />
			</Field>
			<Field label="Allowed aliases" hint="Comma-separated alias names.">
				<Input name="aliases" placeholder="production-chat" />
			</Field>
			<Field label="IP allowlist" hint="Comma-separated IPs or CIDR ranges.">
				<Input name="ip_allowlist" placeholder="203.0.113.0/24" />
			</Field>
			<Field label="Requests per minute" hint="Empty = inherit.">
				<Input name="rpm" type="number" min="0" step="1" inputmode="numeric" />
			</Field>
			<Field label="Tokens per minute" hint="Empty = inherit.">
				<Input name="tpm" type="number" min="0" step="1" inputmode="numeric" />
			</Field>
			<Field label="Concurrent requests" hint="Empty = inherit.">
				<Input name="concurrency" type="number" min="0" step="1" inputmode="numeric" />
			</Field>
			<Field label="Daily spend limit (USD)" hint="Plain amount like 12.50. Empty = inherit.">
				<Input name="dailySpend" placeholder="12.50" inputmode="decimal" />
			</Field>
			<Field label="Monthly spend limit (USD)" hint="Plain amount like 250.00. Empty = inherit.">
				<Input name="monthlySpend" placeholder="250.00" inputmode="decimal" />
			</Field>
			<Button type="submit" variant="primary" {pending}>Create key</Button>
		</form>
	</Card>
</div>

<Guide id="keys-detail" />

<!-- Named: without a heading the table's header row sat directly under the guide's
     last row and the two read as one table. -->
<h2>Project keys</h2>
<TableWrap label="Project keys">
	<table class="fr">
		<thead>
			<tr
				><th>Name</th><th>Prefix</th><th>Environment</th><th>Status</th><th>Created</th><th
					>Last used</th
				><th>Expires</th><th>Actions</th></tr
			>
		</thead>
		<tbody>
			{#each data.keys as k (k.id)}
				<tr>
					<td>
						<a
							href={resolve('/(app)/dashboard/projects/[projectId]/keys/[keyId]', {
								projectId: data.projectId,
								keyId: k.id
							})}>{k.name}</a
						>
					</td>
					<td><code>sk-ar-{k.prefix}…</code></td>
					<td>{k.environmentName ?? '—'}</td>
					<td><Badge tone={statusTone(k.status)}>{k.status}</Badge></td>
					<td class="num">{formatDate(k.createdAt)}</td>
					<td class="num">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : '—'}</td>
					<td class="num">{k.expiresAt ? formatDate(k.expiresAt) : 'never'}</td>
					<td class="fr-actions">
						{#if k.status === 'active'}
							<form method="POST" action="?/disable" use:enhance={track}>
								<input type="hidden" name="id" value={k.id} />
								<Button type="submit" {pending} aria-label="Disable key {k.name}">Disable</Button>
							</form>
						{:else if k.status === 'disabled'}
							<form method="POST" action="?/enable" use:enhance={track}>
								<input type="hidden" name="id" value={k.id} />
								<Button type="submit" {pending} aria-label="Enable key {k.name}">Enable</Button>
							</form>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="8"><EmptyState title="No keys yet" hint="Create one above." /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>

<style>
	.secret {
		display: block;
		margin-top: var(--space-sm);
		word-break: break-all;
	}
	.create {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.narrow {
		max-width: 34rem;
	}
</style>
