<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Badge,
		Button,
		Card,
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
	title="Members"
	lede="Invite people to this workspace, and manage the role each seat holds."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.invited}
	<div class="fr-feedback">
		<Alert tone="success">
			{#if form.invitedLink}
				<strong>Invitation created for {form.invited} — copy the acceptance link now.</strong>
				<code class="secret">{form.invitedLink}</code>
				<span>It is shown once and expires in 7 days.</span>
			{:else}
				<strong>{form.invited} already had an account and was added right away.</strong>
			{/if}
		</Alert>
	</div>
{/if}
{#if form?.resent}
	<div class="fr-feedback">
		<Alert tone="success">
			<strong>Invitation for {form.resent} reissued — copy the new acceptance link now.</strong>
			<code class="secret">{form.invitedLink}</code>
			<span>The previous link no longer works.</span>
		</Alert>
	</div>
{/if}
{#if form?.changed}<div class="fr-feedback"><Alert tone="success">Role updated.</Alert></div>{/if}
{#if form?.removed}<div class="fr-feedback"><Alert tone="success">Member removed.</Alert></div>{/if}
<div class="narrow">
	<Card>
		<h2>Invite someone</h2>
		<form method="POST" action="?/invite" use:enhance={track} class="stack">
			<Field label="Email" hint="If they already have an account, they join immediately.">
				<Input name="email" type="email" placeholder="teammate@example.com" required />
			</Field>
			<Field label="Role">
				<Select name="roleId" required>
					{#each data.roles as r (r.id)}
						<option value={r.id}>{r.name}</option>
					{/each}
				</Select>
			</Field>
			<Button type="submit" variant="primary" {pending}>Send invitation</Button>
		</form>
	</Card>
	<Card>
		<h2>Resend an invitation</h2>
		<p class="muted">
			Reissues the pending link for an email and cancels the old one. Pending invitations are listed
			on the <a href={resolve('/dashboard/team/invitations')}>invitations</a> page.
		</p>
		<form method="POST" action="?/resend" use:enhance={track} class="stack">
			<Field label="Email">
				<Input name="email" type="email" placeholder="teammate@example.com" required />
			</Field>
			<Button type="submit" {pending}>Reissue link</Button>
		</form>
	</Card>
</div>
<Guide id="team" />
<h2>Members</h2>
<TableWrap label="Members">
	<table class="fr">
		<thead>
			<tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.members as m (m.id)}
				<tr>
					<td>
						{m.name}
						{#if m.userId === data.ownerUserId}<Badge tone="info">owner</Badge>{/if}
					</td>
					<td>{m.email}</td>
					<td><Badge tone="neutral">{m.roleName}</Badge></td>
					<td>
						<Badge
							tone={m.status === 'active' ? 'success' : m.status === 'suspended' ? 'warning' : 'info'}
							>{m.status}</Badge
						>
					</td>
					<td class="num">{m.createdAt.toISOString().slice(0, 10)}</td>
					<td class="fr-actions">
						{#if m.userId !== data.ownerUserId}
							<form method="POST" action="?/changeRole" use:enhance={track} class="rowform">
								<input type="hidden" name="memberId" value={m.id} />
								<Select name="roleId" value={m.roleId} size="sm" aria-label="Role for {m.name}">
									{#each data.roles as r (r.id)}
										<option value={r.id}>{r.name}</option>
									{/each}
								</Select>
								<Button type="submit" size="sm" {pending} aria-label="Set role for {m.name}">
									Set role
								</Button>
							</form>
							<form method="POST" action="?/remove" use:enhance={track} class="rowform">
								<input type="hidden" name="memberId" value={m.id} />
								<Input
									name="confirm"
									size="sm"
									placeholder={m.name}
									aria-label={`Type ${m.name} exactly to confirm removal`}
									required
								/>
								<Button type="submit" variant="danger" size="sm" {pending} aria-label="Remove {m.name}">
									Remove
								</Button>
							</form>
						{:else}
							<span class="muted">Owner seat</span>
						{/if}
					</td>
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
	.rowform {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
	}
	.muted {
		color: var(--color-text-muted);
	}
</style>
