<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, Input } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<div class="auth">
	<h1>Log in</h1>
	<Card>
		{#if form?.error}
			<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>
		{/if}
		<form method="POST" use:enhance={track}>
			<Field label="Email">
				<Input name="email" type="email" autocomplete="email" required />
			</Field>
			<Field label="Password">
				<Input name="password" type="password" autocomplete="current-password" required />
			</Field>
			<Button type="submit" variant="primary" {pending}>Log in</Button>
		</form>
	</Card>
	<p class="muted">Need an account? <a href={resolve('/signup')}>Sign up</a></p>
</div>

<style>
	.auth {
		max-width: 24rem;
		margin: var(--fr-space-2xl) auto;
	}
	form {
		display: grid;
		gap: var(--fr-space-md);
	}
	
	p {
		margin-top: var(--fr-space-md);
		text-align: center;
		font-size: var(--fr-text-sm);
	}
</style>
