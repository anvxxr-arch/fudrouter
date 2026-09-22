<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<h1>Sign up</h1>
{#if form?.error}<p class="error">{form.error}</p>{/if}
<form method="POST" use:enhance>
	<label>Name <input name="name" required /></label>
	<label>Email <input name="email" type="email" required /></label>
	<label>Password <input name="password" type="password" minlength="8" required /></label>
	<button type="submit">Create account</button>
</form>
<p><a href="/login">Already have an account? Log in</a></p>

<style>
	form {
		display: grid;
		gap: 0.75rem;
		max-width: 22rem;
	}
	label {
		display: grid;
		gap: 0.25rem;
	}
	.error {
		color: #e66;
	}
</style>
