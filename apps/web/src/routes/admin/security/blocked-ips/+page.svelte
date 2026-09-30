<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
	import {
		Alert,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Blocked IPs"
	lede="Client addresses and subnets refused at the edge. Each entry is an enforcement rule, not a signal — blocked traffic never consumes quota."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.added}
	<div class="fr-feedback"><Alert tone="success">{form.added} blocked.</Alert></div>
{/if}
{#if form?.removed}
	<div class="fr-feedback"><Alert tone="success">Entry unblocked.</Alert></div>
{/if}
<Card>
	<h2 class="first">Block an address</h2>
	<form method="POST" action="?/add" use:enhance={track}>
		<div class="fr-grid">
			<Field label="IP or CIDR" hint="A single address or a subnet, e.g. 203.0.113.0/24">
				<Input name="cidr" placeholder="203.0.113.0/24" required />
			</Field>
			<Field label="Name" hint="Optional note; defaults to the address.">
				<Input name="name" placeholder="lab subnet" />
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Block</Button>
		</div>
	</form>
</Card>
<Guide id="admin-security-blocked-ips" />
<TableWrap label="Blocked addresses">
	<table class="fr">
		<thead>
			<tr><th>Match</th><th>Name</th><th>Added</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.rules as r (r.id)}
				<tr>
					<td><code>{r.cidr}</code></td>
					<td>{r.name}</td>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td class="fr-actions">
						<form method="POST" action="?/remove" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={r.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Unblock {r.cidr}">
								Remove
							</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="4"><EmptyState title="No blocked addresses" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
