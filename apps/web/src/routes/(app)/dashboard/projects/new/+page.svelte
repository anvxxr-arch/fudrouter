<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, Field, Guide, Input, PageHeader, Textarea } from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="New Project"
	lede="A project gets three default environments — development, staging and production — right away."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
<div class="narrow">
	<Card>
		<form method="POST" action="?/create" use:enhance={track} class="stack">
			<Field label="Project name" hint="Required. Something you will recognise later.">
				<Input name="name" placeholder="Prod backend" required />
			</Field>
			<Field label="Slug" hint="Optional — derived from the name when left blank.">
				<Input name="slug" placeholder="prod-backend" />
			</Field>
			<Field label="Description" hint="Optional. What this project is for.">
				<Textarea name="description" rows="3"></Textarea>
			</Field>
			<Button type="submit" variant="primary" {pending}>Create project</Button>
		</form>
	</Card>
</div>
<Guide id="projects" />
<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
</style>
