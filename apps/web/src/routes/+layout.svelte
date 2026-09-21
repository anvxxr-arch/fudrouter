<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { data, children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<nav class="nav">
	<a href="/">fudrouter</a>
	{#if data.user}
		<a href="/keys">API Keys</a>
		<a href="/usage">Usage</a>
		<span>{data.user.email} ({data.user.role})</span>
		<!-- Sign-out is a server action, not a client fetch: auth lives behind
		     $lib/server and the session cookie must be cleared server-side. -->
		<form method="POST" action="/?/logout">
			<button type="submit">Sign out</button>
		</form>
	{:else}
		<a href="/login">Login</a>
		<a href="/signup">Sign up</a>
	{/if}
</nav>

<main>
	{@render children()}
</main>

<style>
	.nav {
		display: flex;
		gap: 1rem;
		align-items: center;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #333;
	}
	.nav span {
		margin-left: auto;
		opacity: 0.7;
	}
	.nav form {
		margin: 0;
	}
</style>
