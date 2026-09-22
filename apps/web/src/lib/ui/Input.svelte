<script lang="ts">
	import { CONTROL_SIZES, warnUnknown, type ControlSize } from '$lib/design/variants';

	// Atom: text input. The shell comes from `.fr-control` so it stays identical to
	// Select and Textarea — those three each used to declare it separately.
	let {
		value = '',
		size = 'md',
		class: className = '',
		...rest
	}: {
		value?: string | number;
		size?: ControlSize;
		class?: string;
	} & Record<string, unknown> = $props();

	$effect(() => warnUnknown(CONTROL_SIZES, size, 'Input', 'size'));
</script>

<input class="fr-control fr-control--{size} {className}" {value} {...rest} />
