<script lang="ts">
	import { Badge, Facts, Guide, PageHeader } from '$lib/ui';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();
</script>

<PageHeader
	title="Status"
	lede="Live check against the router data plane, measured when this page loaded."
/>

<div class="row">
	<Badge tone={data.up ? 'success' : 'danger'}>{data.up ? 'Operational' : 'Unreachable'}</Badge>
	{#if data.service}<span class="muted">{data.service}</span>{/if}
	<span class="muted num">{data.latencyMs} ms</span>
</div>

<Facts
	items={[
		{ term: 'Data plane', detail: data.up ? 'Operational' : 'Unreachable' },
		{ term: 'Service', detail: data.service || '—' },
		{ term: 'Probe', detail: `${data.latencyMs.toLocaleString()} ms` },
		{ term: 'Models published', detail: data.up ? data.models.toLocaleString() : '—' },
		{ term: 'Checked', detail: formatDateTime(new Date(data.checkedAt)) }
	]}
/>

<Guide id="status" />

<div class="table-wrap">
<table class="fr">
	
		<tbody>
			<tr>
				<td>API <code class="muted">/v1/chat/completions</code></td>
				<td class="right">
					<Badge tone={data.up ? 'success' : 'danger'}>{data.up ? 'up' : 'down'}</Badge>
				</td>
			</tr>
			<tr>
				<td>Models published</td>
				<td class="right num">{data.up ? data.models : '—'}</td>
			</tr>
			<tr>
				<td>Health <code class="muted">/health</code></td>
				<td class="right">
					<Badge tone={data.up ? 'success' : 'danger'}>{data.up ? 'up' : 'down'}</Badge>
				</td>
			</tr>
		</tbody>
	</table></div>

<style>
	.row {
		margin-bottom: var(--fr-space-lg);
	}
	.right {
		text-align: right;
	}
</style>
