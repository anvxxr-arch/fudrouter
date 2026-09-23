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
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
		padding: var(--fr-space-card);
	}
</style>
