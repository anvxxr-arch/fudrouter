<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, Field, Input, PageHeader } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<PageHeader title="Account" lede="Your profile and how we address you in the console." />

{#if form?.saved}<div class="fr-feedback"><Alert tone="success">Saved.</Alert></div>{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}

<Card>
	<form method="POST" action="?/save" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name">
				<Input name="name" value={data.account?.name ?? ''} required />
			</Field>
			<Field label="Timezone" hint="IANA name, e.g. Asia/Jakarta.">
				<Input name="timezone" placeholder="Asia/Jakarta" value={data.timezone} />
			</Field>
		</div>
		<Button type="submit" {pending} variant="primary">Save</Button>
	</form>
</Card>

<dl>
	<dt>Email</dt>
	<dd>{data.account?.email}</dd>
	<dt>Role</dt>
	<dd>{data.account?.role ?? 'user'}</dd>
	<dt>Member since</dt>
	<dd class="num">{data.account?.createdAt.toISOString().slice(0, 10)}</dd>
</dl>

<style>
	form {
		display: grid;
		gap: var(--fr-space-md);
	}
	dd {
		margin-bottom: var(--fr-space-sm);
	}
</style>
