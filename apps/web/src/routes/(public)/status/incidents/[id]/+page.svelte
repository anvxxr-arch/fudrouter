<script lang="ts">
	import { Badge, Facts, Guide, PageHeader, TableWrap } from '$lib/ui';
	import { formatDateTime } from '$lib/format';
	import type { Tone } from '$lib/ui';
	let { data } = $props();
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

<PageHeader title={data.incident.title} lede="What happened, when, and how it was resolved." />
<Guide id="incident" />
<div class="fr-status-line">
	<Badge tone={SEVERITY_TONES[data.incident.severity] ?? 'neutral'}>{data.incident.severity}</Badge>
	<Badge tone={INCIDENT_STATUS_TONES[data.incident.status] ?? 'neutral'}>
		{data.incident.statusLabel}
	</Badge>
</div>
<Facts
	items={[
		{
			term: 'Component',
			detail:
				data.incident.componentRaw.toLowerCase() === data.incident.componentLabel.toLowerCase()
					? data.incident.componentLabel
					: `${data.incident.componentLabel} (${data.incident.componentRaw})`
		},
		{ term: 'Status', detail: data.incident.statusLabel },
		{ term: 'Severity', detail: data.incident.severity },
		{
			term: 'Started',
			detail: `${formatDateTime(new Date(data.incident.startedAt))} UTC`
		},
		{
			term: 'Resolved',
			detail: data.incident.resolvedAt
				? `${formatDateTime(new Date(data.incident.resolvedAt))} UTC`
				: '—'
		}
	]}
/>
<h2>Timeline</h2>
{#if data.timeline.some((t) => t.synthesized)}
	<p class="muted">
		A step-by-step timeline was not recorded for this incident — the row below comes from the
		incident's own status and times, not from a recorded history.
	</p>
{/if}
<TableWrap label="Timeline">
	<table class="fr">
		<thead>
			<tr><th>Status</th><th>Note</th><th>Time</th></tr>
		</thead>
		<tbody>
			{#each data.timeline as t}
				<tr>
					<td
						><Badge tone={INCIDENT_STATUS_TONES[t.status] ?? 'neutral'}>{t.statusLabel}</Badge></td
					>
					<td>{t.message || '—'}</td>
					<td class="num">{formatDateTime(new Date(t.createdAt))}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<p class="muted">Times are UTC. <a href="/status">Back to the status page.</a></p>

<style>
	.fr-status-line {
		display: flex;
		gap: var(--space-sm);
		margin-bottom: var(--space-md);
	}
</style>
