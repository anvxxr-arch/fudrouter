<script lang="ts">
	// Atom: multi-line input (header lists, JSON snippets). Shares `.fr-control`
	// with Input and Select; `--multiline` swaps the fixed control height for
	// content-sized padding and a monospace face.
	let {
		value = $bindable(''),
		class: className = '',
		...rest
	}: { value?: string | number; class?: string } & Record<string, unknown> = $props();
	// Two-way write-back so `bind:value` tracks typing; parent oninput still fires.
	function onInput(e: Event): void {
		value = (e.currentTarget as HTMLTextAreaElement).value;
		(rest.oninput as ((ev: Event) => void) | undefined)?.(e);
	}
</script>

<textarea
	class="fr-control fr-control--multiline {className}"
	{...rest}
	{value}
	oninput={onInput}
></textarea>
