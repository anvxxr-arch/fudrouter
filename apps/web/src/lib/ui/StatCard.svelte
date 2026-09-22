<script lang="ts">
	import { STAT_TONES, warnUnknown, type StatTone } from '$lib/design/variants';

	// Atom: a single metric. The value is tabular so a row of stats stays
	// aligned as numbers change (no reflow, no jitter).
	//
	// `tone` replaced the old ad-hoc `'default' | 'success' | 'danger'` union — a
	// third spelling of the same idea that no other atom shared — and now lives in
	// `variants.ts` alongside every other enumerated prop.
	let {
		label,
		value,
		tone = 'neutral'
	}: { label: string; value: string | number; tone?: StatTone } = $props();

	$effect(() => warnUnknown(STAT_TONES, tone, 'StatCard', 'tone'));
</script>

<div class="stat">
	<span class="fr-label">{label}</span>
	<strong class="value num {tone}">{value}</strong>
</div>

<style>
	.stat {
		display: grid;
		gap: var(--fr-space-xs);
		min-width: 8rem;
		padding: var(--fr-space-md);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.value {
		font-size: var(--fr-text-h4);
	}
	/* Only good/bad recolour the number; `neutral` inherits the body colour. */
	.success {
		color: var(--fr-success);
	}
	.danger {
		color: var(--fr-danger);
	}
</style>
