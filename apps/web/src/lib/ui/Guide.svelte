<script lang="ts">
	import { guideFor, type GuideId } from '$lib/guides';
	import Facts from './Facts.svelte';
	import Section from './Section.svelte';

	// Molecule: a page's explanatory copy, composed from Section + Facts.
	// The words live in $lib/guides so a new page is a data entry plus one tag,
	// not a new layout.
	let { id }: { id: GuideId } = $props();
	const guide = $derived(guideFor(id));
</script>

<div class="fr-guide">
	{#each guide.sections as section (section.title)}
		<Section title={section.title} lede={section.lede}>
			{#if section.paragraphs}
				<div class="fr-prose">
					{#each section.paragraphs as paragraph, i (section.title + i)}
						<p>{paragraph}</p>
					{/each}
				</div>
			{/if}
			{#if section.facts}
				<Facts items={section.facts} />
			{/if}
		</Section>
	{/each}
</div>
