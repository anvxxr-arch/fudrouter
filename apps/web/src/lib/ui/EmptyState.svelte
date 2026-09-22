<script lang="ts">
	// Atom: empty state. States what is missing and the next action, rather
	// than leaving a bare "no data" row.
	let { title, hint }: { title: string; hint?: string } = $props();
</script>

<div class="empty">
	<strong>{title}</strong>
	{#if hint}<span class="hint">{hint}</span>{/if}
</div>

<style>
	.empty {
		display: grid;
		gap: var(--fr-space-xs);
		padding: var(--fr-space-xl) var(--fr-space-md);
		text-align: center;
		color: var(--fr-text-muted);
	}
	.hint {
		font-size: var(--fr-text-sm);
	}
</style>
