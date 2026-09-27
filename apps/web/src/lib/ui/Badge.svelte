<script lang="ts">
	import type { Snippet } from 'svelte';
	import { BADGE_TONES, toneClass, warnUnknown, type Tone } from '$lib/design/variants';

	// Atom: status badge. Semantic colour + word, never colour alone — so the
	// meaning survives colour-blindness and greyscale printing.
	//
	// The tone→colour table lives in `.fr-tone-*` (components.css) so this and
	// `Alert` cannot drift: each used to carry its own copy of the same five
	// mappings.
	let { tone = 'neutral', children }: { tone?: Tone; children?: Snippet } = $props();

	$effect(() => warnUnknown(BADGE_TONES, tone, 'Badge', 'tone'));
</script>

<span class="badge {toneClass(tone)}"><span class="dot"></span>{@render children?.()}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 2px var(--space-sm);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		background: var(--color-surface-raised);
		color: var(--_tone);
		font-size: var(--text-caption);
		font-weight: 600;
		white-space: nowrap;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
</style>
