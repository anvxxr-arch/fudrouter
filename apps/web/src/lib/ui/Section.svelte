<script lang="ts">
	import type { Snippet } from 'svelte';

	// Atom: one section of a page. Heading + optional lede + slot. Pages compose
	// this instead of inventing a private h2 rhythm.
	let { title, lede, children }: { title: string; lede?: string; children?: Snippet } = $props();
</script>

<section class="fr-section">
	<header>
		<h2>{title}</h2>
		{#if lede}<p class="fr-lede">{lede}</p>{/if}
	</header>
	{@render children?.()}
</section>
