<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ButtonLink, Card } from '$lib/ui';

	// One boundary for every failure: a 404 from a missing route, a 500 from a
	// load function, a 403 from the capability guard. The status is shown as a
	// number *and* a sentence, so it reads without relying on colour.
	const title = $derived(page.status === 404 ? 'Page not found' : 'Something went wrong');
	const hint = $derived(
		page.status === 404
			? 'That address does not exist on this deployment.'
			: 'This page could not be loaded. Try again, or head back home.'
	);
</script>

<div class="error">
	<Card>
		<span class="code num">{page.status}</span>
		<h1>{title}</h1>
		<p class="muted">{hint}</p>
		{#if page.error?.message && page.status !== 404}
			<p class="detail"><code>{page.error.message}</code></p>
		{/if}
		<div class="actions">
			<ButtonLink variant="primary" href={resolve('/')}>Back to home</ButtonLink>
			{#if page.status !== 404}
				<ButtonLink href={resolve('/status')}>Service status</ButtonLink>
			{/if}
		</div>
	</Card>
</div>

<style>
	.error {
		max-width: 34rem;
		margin: 0 auto;
		/* Centred in the upper half: a card hugging the very top over a screen of
		   empty space reads as unfinished. */
		min-height: 60vh;
		display: grid;
		align-content: center;
	}
	.code {
		display: block;
		color: var(--fr-text-muted);
		font-size: var(--fr-text-caption);
		font-weight: 600;
		letter-spacing: 0.08em;
	}
	h1 {
		margin: var(--fr-space-sm) 0;
	}
	.detail {
		margin: 0 0 var(--fr-space-md);
		font-size: var(--fr-text-sm);
	}
	.actions {
		display: flex;
		gap: var(--fr-space-sm);
		flex-wrap: wrap;
		margin-top: var(--fr-space-md);
	}
</style>
