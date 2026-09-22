<script lang="ts">
	import type { Snippet } from 'svelte';
	import { CONTROL_SIZES, warnUnknown, type ControlSize } from '$lib/design/variants';

	// Atom: native select, sharing the `.fr-control` shell with Input and Textarea.
	//
	// `value` stays undefined by default: passing "" would clear the selection and
	// leave the control blank even when an <option selected> exists.
	let {
		value = undefined,
		size = 'md',
		class: className = '',
		children,
		...rest
	}: {
		value?: string | number;
		size?: ControlSize;
		class?: string;
		children?: Snippet;
	} & Record<string, unknown> = $props();

	$effect(() => warnUnknown(CONTROL_SIZES, size, 'Select', 'size'));
</script>

<select class="fr-control fr-control--{size} {className}" {value} {...rest}
	>{@render children?.()}</select
>
