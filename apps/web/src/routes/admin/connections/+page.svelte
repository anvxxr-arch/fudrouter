<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Alert, Badge, Button, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const healthTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		healthy: 'success',
		degraded: 'warning',
		unhealthy: 'danger',
		unknown: 'neutral'
	};
</script>

<PageHeader
	title="Connections"
	lede="Every upstream endpoint fudrouter can dial, across all providers, with the credentials attached to each."
/>
{#if form?.test}
	<div class="fr-feedback">
		<Alert tone={form.test.ok ? 'success' : 'danger'}>
			Probe → {form.test.ok ? 'reachable' : 'unreachable'}
			{form.test.status ? `(HTTP ${form.test.status})` : ''}
			· {form.test.latencyMs} ms
			{form.test.message ? `· ${form.test.message}` : ''}
			{#if form.test.url}· <code>{form.test.url}</code>{/if}
		</Alert>
	</div>
{/if}
<Guide id="admin-connections" />
<TableWrap label="Connections">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Provider</th><th>Base URL</th><th>Region</th><th>Auth</th><th>Health</th>
				<th>Enabled</th><th>Priority</th><th>Credentials</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.connections as c (c.id)}
				<tr>
					<td>{c.name} <span class="muted"><code>{c.slug}</code></span></td>
					<td>
						<a href={resolve('/admin/providers/[id]', { id: c.providerId })}>{c.providerName}</a>
					</td>
					<td><code>{c.baseUrl}</code></td>
					<td>{c.region ?? '—'}</td>
					<td>{c.authType}</td>
					<td><Badge tone={healthTone[c.healthStatus] ?? 'neutral'}>{c.healthStatus}</Badge></td>
					<td>
						{#if c.enabled}<Badge tone="success">on</Badge>{:else}<Badge tone="neutral">off</Badge>{/if}
					</td>
					<td class="num">{c.priority}</td>
					<td class="num">{c.credentialHealthy}/{c.credentialTotal} healthy</td>
					<td class="fr-actions">
						<form method="POST" action="?/test" use:enhance={track}>
							<input type="hidden" name="id" value={c.providerId} />
							<Button type="submit" {pending} aria-label="Test connection {c.name}">Test</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="10"><EmptyState title="No connections configured" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
