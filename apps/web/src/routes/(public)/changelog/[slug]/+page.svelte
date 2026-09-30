<script lang="ts">
	import { Guide, PageHeader } from '$lib/ui';
	import { formatDate } from '$lib/format';
	let { data } = $props();
	// `entry.html` is already the SAFE renderMarkdown() output produced when the
	// folder was read ($lib/server/changelog) — safe to inline, nothing else.
</script>

<PageHeader title={data.entry.title} lede="Shipped {formatDate(new Date(data.entry.date))}" />
<Guide id="changelog-entry" />
<p class="muted"><a href="/changelog">← All entries</a></p>
<article class="fr-prose">{@html data.entry.html}</article>
<p class="muted"><a href="/changelog">← All entries</a></p>

<style>
	article {
		max-width: 46rem;
		padding-bottom: var(--space-2xl);
	}
</style>
