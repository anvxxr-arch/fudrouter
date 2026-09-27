<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Badge, Button, EmptyState, Guide, PageHeader, TableWrap } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<PageHeader
	title="Connections"
	lede="Routing picks one provider per request. The provider that served the newest call is flagged “in use”."
/>

<p class="muted">
	Last request: {data.lastRequestAt ? data.lastRequestAt.replace('T', ' ').slice(0, 19) : '—'}
</p>

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
				<th>Provider</th><th>Base URL</th><th>Status</th><th>In use</th><th>Requests</th>
				<th>Errors</th><th>Avg latency</th><th>Last call</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.providers as p (p.id)}
				<tr class:inuse={p.inUse}>
					<td>{p.name}</td>
					<td><code>{p.baseUrl}</code></td>
					<td>
						<Badge tone={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Badge>
					</td>
					<td
						>{#if p.inUse}<Badge tone="success">live</Badge>{:else}<span class="muted">—</span
							>{/if}</td
					>
					<td class="num">{p.requests}</td>
					<td class="num"
						>{#if p.errors > 0}<span class="bad">{p.errors}</span>{:else}{p.errors}{/if}</td
					>
					<td class="num">{p.avgLatency} ms</td>
					<td class="num">{p.lastAt ? p.lastAt.replace('T', ' ').slice(0, 19) : 'never'}</td>
					<td class="fr-actions">
						<form method="POST" action="?/test" use:enhance={track}>
							<input type="hidden" name="id" value={p.id} />
							<Button type="submit" {pending} aria-label="Test connection {p.name}">Test</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="9"><EmptyState title="No providers configured" /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>

<style>
	tr.inuse td {
		background: color-mix(in srgb, var(--color-success) 7%, transparent);
	}
</style>
