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
		/* Text stays neutral: DESIGN.md gives Alert a *coloured left border*, and
		   `Badge` is the atom that tints its text. Without this the shared
		   `.fr-tone-*` colour rule would leak in and tint the copy too. */
		color: var(--color-text);
		padding: var(--space-sm) var(--space-md);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		/* The fallback rides in the var() so it cannot outrank the tone class.
		   As a `--_tone: var(--color-info)` DECLARATION it did: this scoped `.alert`
		   selector compiles to `.alert.svelte-xxx` (0,2,0) and beat
		   `.fr-tone-warning` (0,1,0), so every Alert rendered info blue whatever
		   its tone. An unrecognised tone still degrades to the info border. */
		border-left: 3px solid var(--_tone, var(--color-info));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
	}
</style>
