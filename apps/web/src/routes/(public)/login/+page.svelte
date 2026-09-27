<script lang="ts">
	import { enhance } from '$app/forms';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, DiscordButton, Field, Guide, Input } from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>

<div class="auth-centered">
	<h1>Log in</h1>
	<div class="fr-decorative-orb" aria-hidden="true">
		<FluidOrb size={200} color="#3B82F4" />
	</div>
	<Card>
		{#if form?.error}
			<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>
		{/if}
		<DiscordButton />
		<div class="fr-divider"><span>or</span></div>
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
	<p class="swap muted">Need an account? <a href={resolve('/signup')}>Sign up</a></p>
</div>

<Guide id="login" />


