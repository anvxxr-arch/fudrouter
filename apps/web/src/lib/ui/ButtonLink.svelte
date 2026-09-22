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

	// Atom: navigation that looks like a button. It renders the *same* shell as
	// `Button` — one rule set, one variant list — so a CTA and a submit control sit
	// on the same baseline and cannot drift apart again.
	//
	// A link is not a button, so "disabled" is expressed as `aria-disabled` rather
	// than the `disabled` attribute, which does not exist on <a>.
	let {
		variant = 'secondary',
		size = 'md',
		href,
		disabled = false,
		class: className = '',
		children,
		...rest
	}: {
		variant?: ButtonVariant;
		size?: ControlSize;
		href: string;
		disabled?: boolean;
		/** Merged with the variant classes — a caller's class must not replace them. */
		class?: string;
		children?: Snippet;
	} & Record<string, unknown> = $props();

	$effect(() => {
		warnUnknown(BUTTON_VARIANTS, variant, 'ButtonLink', 'variant');
		warnUnknown(CONTROL_SIZES, size, 'ButtonLink', 'size');
	});
</script>

<!-- Callers pass a path already resolved with resolve() from $app/paths, so the raw
     href below is intentional and must not be resolved a second time. The rule
     cannot see that (it only inspects a literal `href`), and Prettier splits this
     element across lines, so the disable has to span the element rather than sit
     on the line above it. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<a
	{href}
	class="{buttonClass(variant, size)} {className}"
	aria-disabled={disabled || undefined}
	tabindex={disabled ? -1 : undefined}
	{...rest}>{@render children?.()}</a
>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
