<script lang="ts">
	// Atom: a single large metric for hero strips and dashboard overviews.
	// Value is tabular (no reflow); label is caption treatment.
	let {
		label,
		value,
		tone = 'neutral'
	}: { label: string; value: string | number; tone?: string } = $props();
</script>

<div class="metric">
	<span class="fr-label">{label}</span>
	<strong class="metric-value num {tone}">{value}</strong>
</div>

<style>
	.metric {
		display: grid;
		gap: var(--space-sm);
		min-width: 6rem;
		padding: var(--space-card);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}
	.metric-value {
		font-size: var(--text-h2);
		font-weight: 700;
		line-height: var(--lh-display);
	}
	.success {
		color: var(--color-success);
	}
	.danger {
		color: var(--color-danger);
	}
</style>
