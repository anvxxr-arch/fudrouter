<script lang="ts">
	import type { Snippet } from 'svelte';

	// Atom: label + control (+ optional hint). Wrapping the control keeps the
	// label click-target part of the field, enlarging the hit area.
	//
	// The label's appearance is the shared `.fr-label` class — the same one the
	// table headers use — rather than a private copy of the same five declarations.
	let { label, hint, children }: { label: string; hint?: string; children?: Snippet } = $props();
</script>

<label class="field">
	<span class="fr-label">{label}</span>
	{@render children?.()}
	{#if hint}<span class="hint">{hint}</span>{/if}
</label>

<style>
	.field {
		display: grid;
		gap: var(--space-xs);
	}
	.hint {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
</style>
