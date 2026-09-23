<script lang="ts">
	import type { Snippet } from 'svelte';

	// Molecule: the scroll container a wide table lives in.
	//
	// It exists as a component for ONE reason: the region must be keyboard
	// focusable. `.table-wrap` is `overflow-x: auto`, so a keyboard user cannot
	// reach the columns that scrolled off — axe reports
	// `scrollable-region-focusable` (serious). `tabindex="0"` is the documented
	// fix; `role="region"` + a name is what makes the focused thing announce as
	// something rather than as an anonymous div.
	//
	// Svelte's own `a11y_no_noninteractive_tabindex` rule does not know the
	// element is a scroll container, so it is a false positive here.
	let { label, children }: { label: string; children?: Snippet } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="table-wrap" tabindex="0" role="region" aria-label={label}>{@render children?.()}</div>
