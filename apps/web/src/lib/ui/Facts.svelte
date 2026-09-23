<script lang="ts">
	export type Fact = { term: string; detail: string };

	// Atom: term/detail list. The term takes the caption treatment; the detail
	// does not — a badge is a value, and so is everything in the right column.
	let { items }: { items: readonly Fact[] } = $props();
</script>

<dl class="fr-dl">
	{#each items as item (item.term)}
		<div>
			<dt class="fr-label">{item.term}</dt>
			<dd>{item.detail}</dd>
		</div>
	{/each}
</dl>
