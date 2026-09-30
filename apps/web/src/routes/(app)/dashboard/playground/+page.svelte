<script lang="ts">
	import { Guide, PageHeader } from '$lib/ui';
	import PlaygroundPanel from '$lib/components/PlaygroundPanel.svelte';
	let { data, form } = $props();
</script>

<PageHeader
	title="Playground"
	lede="Run a real request through the router — same auth, limits, routing and billing as production."
/>
<PlaygroundPanel
	models={data.models}
	aliases={data.aliases}
	keys={data.keys}
	projectId={null}
	runAction="?/run"
	{form}
/>
<Guide id="playground" />
