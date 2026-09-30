<script lang="ts">
	import { Guide, PageHeader } from '$lib/ui';
	import { renderMarkdown } from '$lib/markdown';
	import { DOC_CATEGORIES } from '$lib/docs-content';
	let { data } = $props();
	// Everything renders from the same tree the index lists, so a sidebar link
	// can never point at a page that does not exist. `data.entry` is null on the
	// index (/docs) and set for every /docs/<category>/<page>.
	const teaserOf = (markdown: string): string => {
		const lines = markdown.split('\n');
		const first = lines.find((line) => line.trim() && !line.startsWith('#'));
		return first ? first.trim() : '';
	};
</script>

{#snippet sidebar(currentPath: string | null)}
	<nav class="doc-sidebar" aria-label="Documentation">
		{#each DOC_CATEGORIES as category (category.slug)}
			<section class="side-group">
				<h2 class="fr-label">{category.title}</h2>
				<ul>
					{#each category.pages as page (page.slug)}
						{@const path = `${category.slug}/${page.slug}`}
						{@const current = path === currentPath}
						<li>
							<a href="/docs/{path}" aria-current={current ? 'page' : undefined} class:current
								>{page.title}</a
							>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</nav>
{/snippet}

{#if data.entry === null}
	<!-- /docs: the tree's overview. The Guide renders EXACTLY ONCE across the
	     docs surface — here on the index — per the guides walk's per-page check
	     (other docs pages deliberately carry no guide). -->
	<Guide id="docs" />
	<PageHeader title="Documentation" lede="How this platform works, one page per topic." />
	<div class="doc-layout">
		{@render sidebar(null)}
		<main class="doc-body">
			{#each DOC_CATEGORIES as category (category.slug)}
				<section>
					<h2>{category.title}</h2>
					<div class="cat-grid">
						{#each category.pages as page (page.slug)}
							<a class="cat-card" href="/docs/{category.slug}/{page.slug}">
								<strong>{page.title}</strong>
								<span class="muted">{teaserOf(page.markdown)}</span>
							</a>
						{/each}
					</div>
				</section>
			{/each}
		</main>
	</div>
{:else}
	<PageHeader title={data.entry.title} lede={data.entry.categoryTitle} />
	<div class="doc-layout">
		{@render sidebar(data.entry.path)}
		<main class="doc-body">
			<article class="fr-prose">{@html renderMarkdown(data.entry.markdown)}</article>
			<nav class="doc-pager" aria-label="Docs pagination">
				{#if data.prev}
					<a href="/docs/{data.prev.path}">← {data.prev.title}</a>
				{:else}
					<span></span>
				{/if}
				<a href="/docs">Docs index</a>
				{#if data.next}
					<a href="/docs/{data.next.path}">{data.next.title} →</a>
				{:else}
					<span></span>
				{/if}
			</nav>
		</main>
	</div>
{/if}

<style>
	.doc-layout {
		display: grid;
		grid-template-columns: 14rem minmax(0, 1fr);
		gap: var(--space-xl);
		padding-bottom: var(--space-2xl);
	}
	.doc-sidebar {
		position: sticky;
		top: var(--space-lg);
		align-self: start;
		display: grid;
		gap: var(--space-md);
	}
	.side-group ul {
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-xs);
	}
	.side-group a {
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: var(--text-sm);
	}
	.side-group a.current {
		color: var(--color-text);
		font-weight: 600;
	}
	.doc-body {
		min-width: 0;
	}
	.cat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: var(--space-md);
		margin: var(--space-md) 0 var(--space-xl);
	}
	.cat-card {
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-md);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		text-decoration: none;
		color: var(--color-text);
	}
	.cat-card:hover {
		border-color: var(--color-border-strong);
	}
	.cat-card .muted {
		font-size: var(--text-sm);
		/* The teaser is the page's first line — two clamped lines place the page
		   without turning the index into the docs themselves. */
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.doc-pager {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		margin-top: var(--space-xl);
		border-top: 1px solid var(--color-border);
		padding-top: var(--space-md);
	}
	.doc-pager a {
		font-size: var(--text-sm);
	}
	@media (max-width: 720px) {
		.doc-layout {
			grid-template-columns: 1fr;
		}
	}
</style>
