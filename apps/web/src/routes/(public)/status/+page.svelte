<script lang="ts">
	import { Guide, PageHeader, TableWrap } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();
</script>

<PageHeader title="Status" lede="Health of the data plane that answers your API calls." />

<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={240} color="#3B82F4" />
</div>

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
				<!-- Plain text with the shared tone class in BOTH rows: the column holds
				     a state in one row and a count in the next, so a uniform container is
				     the honest one — a pill on one row only reads as a missing badge, and
				     every Badge carries a status dot a count has nothing to mean. -->
				<td
					><span class={data.up ? 'fr-tone-success' : 'fr-tone-danger'}
						>{data.up ? 'Operational' : 'Unreachable'}</span
					></td
				>
			</tr>
			<tr>
				<td><code>GET /v1/models</code></td>
				<td>
					<span class="num">{data.up ? `${data.models.toLocaleString()} models` : '—'}</span>
				</td>
			</tr>
		</tbody>
	</table>
</TableWrap>

<Guide id="status" />
