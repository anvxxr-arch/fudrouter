<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		EmptyState,
		Guide,
		PageHeader,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatDate } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Invitations"
	lede="Pending acceptance links. Only the token hash is stored — a link can be revoked here, never read back."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.revoked}
	<div class="fr-feedback">
		<Alert tone="success">Invitation for {form.revoked} revoked.</Alert>
	</div>
{/if}
<Guide id="team" />
<h2>Pending</h2>
<TableWrap label="Pending invitations">
	<table class="fr">
		<thead>
			<tr><th>Email</th><th>Role</th><th>Invited by</th><th>Expires</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.invitations as inv (inv.id)}
				<tr>
					<td>{inv.email}</td>
					<td><Badge tone="neutral">{data.roles.find((r) => r.id === inv.roleId)?.name ?? '—'}</Badge></td>
					<td>{inv.invitedBy}</td>
					<td class="num">{formatDate(inv.expiresAt)}</td>
					<td class="fr-actions">
						<form method="POST" action="?/revoke" use:enhance={track}>
							<input type="hidden" name="identifier" value={inv.identifier} />
							<Button type="submit" variant="danger" {pending} aria-label="Revoke invitation for {inv.email}">
								Revoke
							</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="5"
						><EmptyState title="No pending invitations" hint="Invite someone from the members page."
						/></td
					></tr
				>
			{/each}
		</tbody>
	</table></TableWrap
>
