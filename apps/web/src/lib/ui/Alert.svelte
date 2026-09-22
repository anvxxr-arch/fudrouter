<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ALERT_TONES, toneClass, warnUnknown, type AlertTone } from '$lib/design/variants';

	// Atom: inline feedback. Carries a left border in the semantic colour so
	// the tone is readable at a glance without a filled background.
	//
	// The tone→colour table is the shared `.fr-tone-*` one, not a private copy.
	let { tone = 'info', children }: { tone?: AlertTone; children?: Snippet } = $props();

	$effect(() => warnUnknown(ALERT_TONES, tone, 'Alert', 'tone'));

	// `role="status"` is polite: it waits for a pause before announcing. A failure
	// should not wait — it is `role="alert"`, which interrupts. Both were `status`
	// before, so a failed save was announced as quietly as a success.
	const role = $derived(tone === 'danger' ? 'alert' : 'status');
</script>

<div class="alert {toneClass(tone)}" {role}>{@render children?.()}</div>

<style>
	.alert {
		/* A default so an unrecognised tone degrades to the info border rather than
		   an invalid `border-left-color`, which would fall back to currentColor. */
		--_tone: var(--fr-info);
		padding: var(--fr-space-sm) var(--fr-space-md);
		background: var(--fr-surface);
		border: 1px solid var(--fr-border);
		border-left: 3px solid var(--_tone);
		border-radius: var(--fr-radius-md);
		font-size: var(--fr-text-sm);
	}
</style>
