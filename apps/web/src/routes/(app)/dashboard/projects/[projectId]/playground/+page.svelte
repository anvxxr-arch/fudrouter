<script lang="ts">
	import { Guide, PageHeader } from '$lib/ui';
	import PlaygroundPanel from '$lib/components/PlaygroundPanel.svelte';
	let { data, form } = $props();
</script>

<PageHeader
	title="Project playground"
	lede="Run a real request through the router in {data.project.name}'s context."
/>
<PlaygroundPanel
	models={data.models}
	aliases={data.aliases}
	keys={data.keys}
	projectId={data.project.id}
	runAction="?/run"
	{form}
/>
<Guide id="playground" />
