<script lang="ts">
	import type { Snippet } from 'svelte';

	// Atom: page title + optional lede + optional actions slot. Gives every
	// surface the same top-of-page rhythm.
	let { title, lede, actions }: { title: string; lede?: string; actions?: Snippet } = $props();
</script>

<header class="page-header">
	<div>
		<h1>{title}</h1>
		{#if lede}<p class="lede">{lede}</p>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
		margin-top: var(--space-lg);
		margin-bottom: var(--space-md);
	}
	.lede {
		margin: 0;
		color: var(--color-text-muted);
		max-width: 46rem;
	}
	.actions {
		display: flex;
		gap: var(--space-sm);
		flex-shrink: 0;
	}
</style>
