<script lang="ts">
	import { Counter, PageHeader, TableWrap } from '$lib/ui';
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
	<!-- The probe number is the one value on this page that moves between
	     refreshes, so it rolls rather than snaps. `label` keeps it announced:
	     the digits are painted as a transformed column, which reads as noise to
	     a screen reader, so the accessible name carries the number instead. -->
	<span class="num"
		>probe <Counter value={data.latencyMs} size="sm" label={String(data.latencyMs)} /> ms</span
	>
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
					{#if data.up}
						<span class="num"
							><Counter value={data.models} size="sm" label={String(data.models)} /> models</span
						>
					{:else}
						<span class="num">—</span>
					{/if}
				</td>
			</tr>
		</tbody>
	</table>
</TableWrap>

