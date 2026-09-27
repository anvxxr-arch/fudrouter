<script lang="ts">
	import { enhance } from '$app/forms';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { Alert, Button, Card, Facts, Field, Guide, Input, PageHeader } from '$lib/ui';
	import { formatDate } from '$lib/format';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={220} color="#3B82F4" />
</div>
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

<Facts
	items={[
		{ term: 'Email', detail: data.account?.email ?? '—' },
		{ term: 'Role', detail: data.account?.role ?? 'user' },
		{
			term: 'Member since',
			detail: data.account ? formatDate(data.account.createdAt) : '—'
		}
	]}
/>

<Guide id="account" />


