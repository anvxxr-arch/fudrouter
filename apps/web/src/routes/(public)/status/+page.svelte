<script lang="ts">
	import { Badge, Guide, PageHeader, TableWrap } from '$lib/ui';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();
</script>

<PageHeader
	title="Status"
	lede="Health of the data plane that answers your API calls."
/>

<!-- One focal answer to "is it working?": a dot AND the word, so it reads without
     colour. The page used to state the same health four times across three blocks
     and used two vocabularies ("Operational" and "up") for one state. -->
<div class="indicator" class:down={!data.up}>
	<span class="dot" aria-hidden="true"></span>
	<strong class="state">{data.up ? 'Operational' : 'Unreachable'}</strong>
	{#if data.service}
		<span class="sep" aria-hidden="true">·</span>
		<span class="muted">{data.service}</span>
	{/if}
</div>

<p class="meta muted">
	<span class="num">Checked {formatDateTime(new Date(data.checkedAt))} UTC</span> ·
	<span class="num">probe {data.latencyMs.toLocaleString()} ms</span>
</p>

<!-- The two calls this page actually makes. The old table listed
     `/v1/chat/completions` as independently probed, which it never was. -->
<h2>Checks</h2>
<TableWrap label="Checks">
	<table class="fr">
		<thead>
			<tr><th>Call</th><th>Result</th></tr>
		</thead>
		<tbody>
			<tr>
				<td><code>GET /health</code></td>
				<td>
					<!-- The same word the indicator uses: one vocabulary for one state. -->
					<Badge tone={data.up ? 'success' : 'danger'}>
						{data.up ? 'Operational' : 'Unreachable'}
					</Badge>
				</td>
			</tr>
			<tr>
				<td><code>GET /v1/models</code></td>
				<!-- Plain text, not a Badge: a count is not a state, and every Badge
				     carries a status dot that would read as a warning here. -->
				<td>
					<span class="num">{data.up ? `${data.models.toLocaleString()} models` : '—'}</span>
				</td>
			</tr>
		</tbody>
	</table>
</TableWrap>

<Guide id="status" />

<style>
	.indicator {
		display: flex;
		align-items: center;
		gap: var(--fr-space-sm);
		margin-top: var(--fr-space-md);
	}
	.dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: var(--fr-radius-pill);
		background: var(--fr-success);
	}
	.indicator.down .dot {
		background: var(--fr-danger);
	}
	.state {
		font-size: var(--fr-text-h4);
	}
	.sep {
		color: var(--fr-text-muted);
	}
	.meta {
		margin: var(--fr-space-sm) 0 0;
		font-size: var(--fr-text-sm);
	}
</style>
