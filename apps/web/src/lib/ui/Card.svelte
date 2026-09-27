<script lang="ts">
	import type { Snippet } from 'svelte';

	// Atom: surface panel. Depth is border + surface step, never a shadow.
	let {
		class: className = '',
		children,
		...rest
	}: { class?: string; children?: Snippet } & Record<string, unknown> = $props();
</script>

<div class="card {className}" {...rest}>{@render children?.()}</div>

<style>
	.card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-card);
	}
</style>
