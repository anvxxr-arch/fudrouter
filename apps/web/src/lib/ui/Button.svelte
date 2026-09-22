<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		BUTTON_VARIANTS,
		CONTROL_SIZES,
		buttonClass,
		warnUnknown,
		type ButtonVariant,
		type ControlSize
	} from '$lib/design/variants';

	// Atom: the high-emphasis control. `primary` is reserved for the one action
	// worth taking on a screen (Von Restorff — the distinct item is the one users
	// find); everything else is `secondary`; destructive work is `danger` and never
	// primary.
	//
	// The visual language lives in `lib/design/components.css`, not in a `<style>`
	// block here, because `ButtonLink` renders the identical shell — and the two had
	// already drifted apart while each owned a private copy of it.
	let {
		variant = 'secondary',
		size = 'md',
		type = 'button',
		pending = false,
		disabled = false,
		class: className = '',
		children,
		...rest
	}: {
		variant?: ButtonVariant;
		size?: ControlSize;
		type?: 'button' | 'submit' | 'reset';
		/** In-flight request: disables the control and announces busy. */
		pending?: boolean;
		disabled?: boolean;
		/** Merged with the variant classes — a caller's class must not replace them. */
		class?: string;
		children?: Snippet;
	} & Record<string, unknown> = $props();

	$effect(() => {
		warnUnknown(BUTTON_VARIANTS, variant, 'Button', 'variant');
		warnUnknown(CONTROL_SIZES, size, 'Button', 'size');
	});
</script>

<button
	{type}
	class="{buttonClass(variant, size)} {className}"
	disabled={disabled || pending}
	aria-busy={pending || undefined}
	{...rest}
>
	{@render children?.()}{#if pending}<span aria-hidden="true">…</span>{/if}
</button>
