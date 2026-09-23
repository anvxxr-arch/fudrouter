<script lang="ts">
	// Atom: a labeled sample. `pre` styling lives in tokens.css; this only adds
	// the caption so docs do not each invent a heading-plus-pre pair.
	let { label, code }: { label?: string; code: string } = $props();
</script>

<figure class="fr-code">
	{#if label}<figcaption class="fr-label">{label}</figcaption>{/if}
	<pre>{code}</pre>
</figure>
