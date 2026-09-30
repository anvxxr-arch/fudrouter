<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
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
</script>
<PageHeader
	title="Blocked keys"
	lede="API keys refused at the edge, kept here so a block can be reviewed and lifted. Only the key's name and prefix are shown — the secret is hashed and never stored in plaintext."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.added}
	<div class="fr-feedback"><Alert tone="success">Key “{form.added}” blocked.</Alert></div>
{/if}
{#if form?.removed}
	<div class="fr-feedback"><Alert tone="success">Key unblocked.</Alert></div>
{/if}
<Card>
	<h2 class="first">Block a key</h2>
	<form method="POST" action="?/add" use:enhance={track}>
		<div class="fr-grid">
			<Field label="API key">
				<Select name="key_id" required>
					<option value="" selected disabled>Select a key…</option>
					{#each data.keys as k (k.id)}
						<option value={k.id}>{k.name} ({k.prefix}…)</option>
					{/each}
				</Select>
			</Field>
			<Field label="Name" hint="Optional note; defaults to the key prefix.">
				<Input name="name" placeholder="compromised staging key" />
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary" disabled={data.keys.length === 0}>
				Block key
			</Button>
		</div>
	</form>
</Card>
<Guide id="admin-security-blocked-keys" />
<TableWrap label="Blocked keys">
	<table class="fr">
		<thead>
			<tr><th>Key</th><th>Prefix</th><th>Key status</th><th>Name</th><th>Blocked</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.rules as r (r.id)}
				<tr>
					<td><code>{r.keyId}</code></td>
					<td><code>{r.keyPrefix ?? '—'}</code></td>
					<td>
						{#if r.keyStatus}
							<Badge tone={r.keyStatus === 'active' ? 'success' : 'warning'}>{r.keyStatus}</Badge>
						{:else}
							<Badge tone="neutral">gone</Badge>
						{/if}
					</td>
					<td>{r.keyName ?? r.name}</td>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td class="fr-actions">
						<form method="POST" action="?/remove" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={r.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Unblock key {r.name}">
								Remove
							</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="6"><EmptyState title="No blocked keys" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
