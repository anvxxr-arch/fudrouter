<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Badge, Button, Card, Guide, PageHeader } from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatDateTime } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Accept Invitation"
	lede="You have been invited to join a workspace on fudrouter."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
<div class="narrow">
	<Card>
		<dl class="facts">
			<dt>Workspace</dt>
			<dd>{data.workspaceName}</dd>
			<dt>Invited email</dt>
			<dd>{data.invite.email}</dd>
			<dt>Role</dt>
			<dd><Badge tone="info">{data.roleName}</Badge></dd>
			<dt>Expires</dt>
			<dd>{formatDateTime(data.expiresAt)}</dd>
		</dl>
		<p class="muted">
			Accepting adds <strong>{data.invite.email}</strong> to this workspace. If that is not your
			account, sign in with it first — or decline.
		</p>
		<form method="POST" action="?/accept" use:enhance={track} class="rowform">
			<Button type="submit" variant="primary" {pending}>Accept invitation</Button>
		</form>
		<form method="POST" action="?/decline" use:enhance={track} class="rowform">
			<Button type="submit" variant="danger" {pending}>Decline</Button>
		</form>
	</Card>
</div>
<Guide id="invite" />
<style>
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-xs) var(--space-md);
		margin: 0 0 var(--space-md);
	}
	dt {
		color: var(--color-text-muted);
	}
	.rowform {
		display: flex;
		gap: var(--space-sm);
		margin-top: var(--space-sm);
	}
	.muted {
		color: var(--color-text-muted);
	}
</style>
