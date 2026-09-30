<script lang="ts">
	import { Alert, Badge, Counter, EmptyState, PageHeader, TableWrap } from '$lib/ui';
	import FluidOrb from '$lib/components/fluid-orb.svelte';
	import { formatDateTime } from '$lib/format';
	import type { Tone } from '$lib/ui';
	import type { ComponentState } from '$lib/status';
	let { data } = $props();
	// The state word comes from STATE_LABELS on the server; the tone is only
	// its colour affordance — the word carries the meaning.
	const STATE_TONES: Record<ComponentState, Tone> = {
		operational: 'success',
		degraded: 'warning',
		'partial-outage': 'warning',
		'major-outage': 'danger',
		maintenance: 'info'
	};
	const SEVERITY_TONES: Record<string, Tone> = {
		minor: 'info',
		major: 'warning',
		critical: 'danger'
	};
	const INCIDENT_STATUS_TONES: Record<string, Tone> = {
		investigating: 'danger',
		identified: 'warning',
		monitoring: 'info',
		resolved: 'success'
	};
</script>

<PageHeader title="Status" lede="Health of the data plane that answers your API calls." />
<div class="fr-decorative-orb" aria-hidden="true">
	<FluidOrb size={240} color="#3B82F4" />
</div>
<!-- One focal answer to "is it working?": a dot AND the word, so it reads without
     colour. The banner word is the worst of the six component states below. -->
<div class="indicator" class:down={data.overall.state !== 'operational'}>
	<span class="dot" aria-hidden="true"></span>
	<strong class="state">{data.overall.label}</strong>
	{#if data.probe.service}
		<span class="sep" aria-hidden="true">·</span>
		<span class="muted">{data.probe.service}</span>
	{/if}
</div>
<p class="meta muted">
	<span class="num">Checked {formatDateTime(new Date(data.probe.checkedAt))} UTC</span> ·
	<!-- The probe number is the one value on this page that moves between
	     refreshes, so it rolls rather than snaps. `label` keeps it announced:
	     the digits are painted as a transformed column, which reads as noise to
	     a screen reader, so the accessible name carries the number instead. -->
	<span class="num"
		>probe <Counter value={data.probe.latencyMs} size="sm" label={String(data.probe.latencyMs)} /> ms</span
	>
</p>
<h2>Components</h2>
<!-- How every state on this page is derived, said once, in the open:
     open incidents first, live probe overlaid where it speaks. -->
<p class="meta muted">
	Each state starts from open incidents and is then overlaid with the live data-plane probe on
	components the probe speaks to (Gateway, Dashboard, Database-facing services). Where both speak
	and disagree, the worse state wins. Authentication and Billing have no independent probe — their
	state comes from reported incidents alone. All times are UTC.
</p>
<TableWrap label="Components">
	<table class="fr">
		<thead>
			<tr><th>Component</th><th>Status</th><th>Derived from</th></tr>
		</thead>
		<tbody>
			{#each data.components as c (c.key)}
				<tr>
					<td>
						<strong>{c.label}</strong>
						<br />
						<span class="muted">{c.description}</span>
					</td>
					<td>
						{#if c.state}
							<Badge tone={STATE_TONES[c.state]}>{c.stateLabel}</Badge>
						{:else}
							<Badge tone="neutral">Unknown</Badge>
						{/if}
					</td>
					<td class="muted">{c.basis}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
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
					><span class={data.probe.ok ? 'fr-tone-success' : 'fr-tone-danger'}
						>{data.probe.ok ? 'Operational' : 'Unreachable'}</span
					>
					{#if !data.probe.ok && data.probe.error}
						<span class="muted"> — {data.probe.error}</span>
					{/if}</td
				>
			</tr>
			<tr>
				<td><code>GET /v1/models</code></td>
				<td>
					{#if data.probe.models !== null}
						<span class="num"
							><Counter
								value={data.probe.models}
								size="sm"
								label={String(data.probe.models)}
							/> models</span
						>
					{:else}
						<span class="num">—</span>
					{/if}
				</td>
			</tr>
		</tbody>
	</table>
</TableWrap>
<h2>Incidents</h2>
{#if data.incidents === null}
	<!-- Degrade, never 500: the probe above still rendered, only the incident
	     history is unknown. PRD §130's four answers, inline. -->
	<Alert tone="warning">
		<strong>What happened?</strong> Incident history could not be loaded.<br />
		<strong>Why?</strong> The incident database could not be read just now.<br />
		<strong>What can I do?</strong> Reload this page in a moment; the live checks above are
		unaffected.<br />
		<strong>Request ID:</strong> <code>{data.dbErrorRequestId}</code>
	</Alert>
{:else if data.incidents.length === 0}
	<EmptyState
		title="No incidents recorded"
		hint="When something breaks, the incident and its timeline appear here."
	/>
{:else}
	<TableWrap label="Incidents">
		<table class="fr">
			<thead>
				<tr>
					<th>Incident</th><th>Severity</th><th>Status</th><th>Component</th><th>Started</th
					><th>Resolved</th>
				</tr>
			</thead>
			<tbody>
				{#each data.incidents as i (i.id)}
					<tr>
						<td><a href={`/status/incidents/${i.id}`}>{i.title}</a></td>
						<td><Badge tone={SEVERITY_TONES[i.severity] ?? 'neutral'}>{i.severity}</Badge></td>
						<td
							><Badge tone={INCIDENT_STATUS_TONES[i.status] ?? 'neutral'}
								>{i.statusLabel}</Badge
							></td
						>
						<td>{i.componentLabel}</td>
						<td class="num">{formatDateTime(new Date(i.startedAt))}</td>
						<td class="num"
							>{#if i.resolvedAt}{formatDateTime(new Date(i.resolvedAt))}{:else}—{/if}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
	<p class="meta muted">Open incidents first, then newest first. Times are UTC.</p>
{/if}
