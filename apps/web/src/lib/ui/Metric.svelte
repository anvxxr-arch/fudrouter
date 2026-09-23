<script lang="ts">
	// Atom: a single large metric for hero strips and dashboard overviews.
	// Value is tabular (no reflow); label is caption treatment.
	let { label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: string } = $props();
</script>

<div class="metric">
	<span class="fr-label">{label}</span>
	<strong class="metric-value num {tone}">{value}</strong>
</div>

<style>
	.metric {
		display: grid;
		gap: var(--fr-space-xs);
		min-width: 6rem;
		padding: var(--fr-space-md);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-radius: var(--fr-radius-lg);
	}
	.metric-value {
		font-size: var(--fr-text-h3);
		font-weight: 700;
		line-height: 1.1;
	}
	.success {
		color: var(--fr-success);
	}
	.danger {
		color: var(--fr-danger);
	}
</style>
