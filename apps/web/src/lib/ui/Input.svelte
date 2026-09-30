<script lang="ts">
	import { CONTROL_SIZES, warnUnknown, type ControlSize } from '$lib/design/variants';

	// Atom: text input. The shell comes from `.fr-control` so it stays identical to
	// Select and Textarea — those three each used to declare it separately.
	let {
		value = $bindable(''),
		size = 'md',
		class: className = '',
		...rest
	}: {
		value?: string | number;
		size?: ControlSize;
		class?: string;
	} & Record<string, unknown> = $props();

	$effect(() => warnUnknown(CONTROL_SIZES, size, 'Input', 'size'));
	// Two-way write-back: `value` is $bindable, so a parent's `bind:value` tracks
	// typing. A parent's own oninput still fires (it rides in `rest`).
	function onInput(e: Event): void {
		value = (e.currentTarget as HTMLInputElement).value;
		(rest.oninput as ((ev: Event) => void) | undefined)?.(e);
	}
</script>

<input class="fr-control fr-control--{size} {className}" {...rest} {value} oninput={onInput} />
