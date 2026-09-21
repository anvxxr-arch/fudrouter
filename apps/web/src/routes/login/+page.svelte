<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<h1>Log in</h1>
{#if form?.error}<p class="error">{form.error}</p>{/if}
<form method="POST" use:enhance>
	<label>Email <input name="email" type="email" required /></label>
	<label>Password <input name="password" type="password" required /></label>
	<button type="submit">Log in</button>
</form>
<p><a href="/signup">Need an account? Sign up</a></p>

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
