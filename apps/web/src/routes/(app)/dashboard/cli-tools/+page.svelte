<script lang="ts">
	import { CLI_TOOLS, API_KEY_PLACEHOLDER, type CliTarget } from '$lib/cli-tools';
	import { Card, CodeBlock, Guide, PageHeader, Section, Select } from '$lib/ui';

	let { data } = $props();

	// The two inputs a snippet depends on. The key is never rendered as a
	// secret: the page only knows the prefix, so the snippet carries a
	// placeholder the user replaces with the key they saved at creation time.
	let model = $state(data.models[0]?.slug ?? '');
	let keyPrefix = $state('');

	const target = $derived<CliTarget>({
		baseUrl: data.baseUrl,
		model,
		apiKey: keyPrefix ? `${keyPrefix}…` : API_KEY_PLACEHOLDER
	});

	const rendered = $derived(CLI_TOOLS.map((tool) => ({ tool, snippets: tool.snippets(target) })));
</script>

<PageHeader
	title="Connect a client"
	lede="Point a coding agent or editor at the router. Copy the config for your tool — auth, routing, limits and billing all run exactly as in production."
/>

<Card>
	<Section
		title="Your target"
		lede="Pick a model and, optionally, one of your keys. The snippets below update to match."
	>
		<div class="target">
			<label>
				<span>Model</span>
				<Select bind:value={model}>
					{#each data.models as m (m.slug)}
						<option value={m.slug}>{m.slug}{m.developer ? ` — ${m.developer}` : ''}</option>
					{/each}
				</Select>
			</label>
			<label>
				<span>Key (optional)</span>
				<Select bind:value={keyPrefix}>
					<option value="">— use a placeholder —</option>
					{#each data.keys as k (k.id)}
						<option value={k.prefix}>{k.name} ({k.prefix}…)</option>
					{/each}
				</Select>
			</label>
		</div>
		<p class="hint">
			Key secrets are shown once at creation and stored hashed, so a snippet can only carry the
			prefix. Paste the secret you saved in place of the placeholder.
		</p>
		<p class="hint">
			Base URL: <code>{data.baseUrl}</code>
		</p>
	</Section>
</Card>

{#each rendered as { tool, snippets } (tool.id)}
	<Card>
		<Section title={tool.name} lede={tool.summary}>
			<ol class="steps">
				{#each tool.steps as step, i (i)}
					<li>{step}</li>
				{/each}
			</ol>
			{#if tool.install}
				<CodeBlock label="install" code={tool.install} />
			{/if}
			{#each snippets as snippet (snippet.label)}
				<CodeBlock label={snippet.label} code={snippet.code} />
			{/each}
			{#if tool.docsUrl}
				<p class="hint">
					Docs: <a href={tool.docsUrl} rel="noreferrer noopener" target="_blank">{tool.docsUrl}</a>
				</p>
			{/if}
		</Section>
	</Card>
{/each}

<Guide id="cli-tools" />

<style>
	.target {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-md);
		margin-bottom: var(--space-sm);
	}
	.target label {
		display: grid;
		gap: var(--space-xs);
	}
	.target span {
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.hint {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.steps {
		margin: 0 0 var(--space-sm);
		padding-left: var(--space-lg);
		color: var(--color-text-muted);
	}
	.steps li {
		margin-bottom: var(--space-xs);
	}
	@media (max-width: 820px) {
		.target {
			grid-template-columns: 1fr;
		}
	}
</style>
