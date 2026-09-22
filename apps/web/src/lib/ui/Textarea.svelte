<script lang="ts">
	// Atom: multi-line input (header lists, JSON snippets). Shares `.fr-control`
	// with Input and Select; `--multiline` swaps the fixed control height for
	// content-sized padding and a monospace face.
	let {
		value = '',
		class: className = '',
		...rest
	}: { value?: string | number; class?: string } & Record<string, unknown> = $props();
</script>

<textarea class="fr-control fr-control--multiline {className}" {value} {...rest}></textarea>
