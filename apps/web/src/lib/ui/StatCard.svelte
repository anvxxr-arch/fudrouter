<script lang="ts">
	import { STAT_TONES, warnUnknown, type StatTone } from '$lib/design/variants';

	// Atom: a single metric. The value is tabular so a row of stats stays
	// aligned as numbers change (no reflow, no jitter).
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
		gap: var(--space-sm);
		min-width: 8rem;
		padding: var(--space-card);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}
	.value {
		font-size: var(--text-h3);
		line-height: var(--lh-display);
	}
	.success {
		color: var(--color-success);
	}
	.warning {
		color: var(--warning);
	}
	.danger {
		color: var(--color-danger);
	}
</style>
