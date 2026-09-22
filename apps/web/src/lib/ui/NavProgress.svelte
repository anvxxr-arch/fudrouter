<script lang="ts">
	import { navigating } from '$app/state';

	// Atom: route-load progress bar. Reads `$app/state` `navigating` (no props —
	// whose fields are all `null` when idle, so `to !== null` is the "in flight" test.
	// Without it a click looks like nothing happened until the server answers.
	const busy = $derived(navigating.to !== null);
</script>

{#if busy}
	<div class="progress" role="presentation"></div>
{/if}

<!-- Announced to assistive tech, invisible on screen. -->
<span class="sr-only" role="status" aria-live="polite">{busy ? 'Loading page' : ''}</span>

<style>
	.progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--fr-primary);
		z-index: 200;
	}
</style>
