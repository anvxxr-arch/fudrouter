<script lang="ts">
	import { EmptyState, Guide, PageHeader } from '$lib/ui';
	import { formatDate } from '$lib/format';
	import { renderMarkdown } from '$lib/markdown';
	let { data } = $props();
	const excerptOf = (html: string): string => {
		const paragraph = /<p>([\s\S]*?)<\/p>/.exec(html);
		return paragraph ? paragraph[1] : '';
	};
</script>

<PageHeader title="Changelog" lede="Shipped changes to the platform, newest first." />
<Guide id="changelog" />
<!-- The source statement is deliberately one muted line: a reader checking
     "did this ship?" needs the guarantee, not an essay about the workflow. -->
<p class="muted">One markdown file per release in the docs/changelog folder is the source of truth.</p>
{#if data.entries.length === 0}
	<EmptyState title="No releases yet" hint="Entries appear here as they ship." />
{:else}
	<ul class="entry-list">
		{#each data.entries as entry (entry.slug)}
			<li class="entry">
				<p class="fr-label num">{formatDate(new Date(entry.date))}</p>
				<h2><a href="/changelog/{entry.slug}">{entry.title}</a></h2>
				{#if excerptOf(entry.html)}
					<p class="muted excerpt">{@html excerptOf(entry.html)}</p>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.entry-list {
		list-style: none;
		margin: 0;
		padding: 0 0 var(--space-2xl);
		display: grid;
		gap: var(--space-xl);
	}
	.entry h2 {
		margin: var(--space-xs) 0;
	}
	.excerpt {
		margin: 0;
	}
</style>
