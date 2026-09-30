<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
	import { withPending } from '$lib/forms';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Guide,
		Input,
		PageHeader,
		Section,
		Select,
		TableWrap,
		UxState
	} from '$lib/ui';
	import type { Tone } from '$lib/ui';
	let { data, form } = $props();
	let pending = $state(false);
	const uxState = $derived(
		data.denied ? 'denied' : data.queryError ? 'error' : data.alerts.length ? 'success' : 'empty'
	);
	// The threshold's unit follows its condition type (lib/server/alerts.ts pins
	// one unit per type) — show the number with the unit it is stored in.
	const unitFor = (type: string): string =>
		type === 'latency' ? 'ms' : type === 'budget_threshold' || type === 'credit_threshold' ? 'μ$' : 'ratio';
	const eventTone: Record<string, Tone> = { firing: 'danger', resolved: 'success' };
</script>

<PageHeader title="Alerts" lede={`Watchers on ${data.projectName || 'this project'} and their event history.`} />
<Guide id="alerts" />

{#if form?.error}
	<Alert tone="danger">{form.error}</Alert>
{/if}
{#if form?.saved}
	<Alert tone="success">Alert saved.</Alert>
{/if}
{#if form?.removed}
	<Alert tone="success">Alert removed.</Alert>
{/if}

{#if !data.denied}
	<Section title="Create an alert" lede="Name it, pick what to watch, and where the event goes.">
		<form class="grid" method="POST" action="?/create" use:enhance={withPending((v) => (pending = v))}>
			<Field label="Name"><Input name="name" required placeholder="Error rate spike" /></Field>
			<Field label="Condition">
				<Select name="type">
					{#each data.conditionTypes as t (t)}
						<option value={t}>{data.conditionLabels[t]}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Threshold"><Input name="threshold" inputmode="decimal" required placeholder="0.05" /></Field>
			<Field label="Window (seconds)" hint="Lookback for rate/latency conditions">
				<Input type="number" name="windowSeconds" min="1" placeholder="300" />
			</Field>
			<Field label="Baseline rate" hint="Only for unusual key traffic">
				<Input name="baselineRate" inputmode="decimal" placeholder="0.01" />
			</Field>
			<Field label="Channel">
				<Select name="channel">
					{#each data.channels as ch (ch)}
						<option value={ch}>{ch}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Enabled"><input type="checkbox" name="enabled" checked /></Field>
			<div class="actions">
				<Button type="submit" variant="primary" {pending}>Create alert</Button>
			</div>
		</form>
	</Section>
{/if}

<UxState
	state={uxState}
	emptyTitle="No alerts yet"
	emptyHint="Create one to get an event when a threshold is crossed."
	errorWhat={data.queryError ?? undefined}
	errorWhy="Reading alerts failed on the server."
>
	<Section title="Project alerts">
		<TableWrap label="Project alerts">
			<table class="fr">
				<thead>
					<tr>
						<th>Name</th><th>Condition</th><th>Threshold</th><th>Window</th><th>Channel</th>
						<th>Enabled</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.alerts as a (a.id)}
						<tr>
							<td>{a.name}</td>
							<td>{data.conditionLabels[a.condition.type]}</td>
							<td class="num">{a.condition.threshold} {unitFor(a.condition.type)}</td>
							<td class="num">{a.condition.windowSeconds}s</td>
							<td>{a.channel}</td>
							<td><Badge tone={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'On' : 'Off'}</Badge></td>
							<td class="row-actions">
								<form method="POST" action="?/update" use:enhance={withPending((v) => (pending = v))}>
									<input type="hidden" name="id" value={a.id} />
									<input type="hidden" name="name" value={a.name} />
									<input type="hidden" name="type" value={a.condition.type} />
									<input type="hidden" name="threshold" value={a.condition.threshold} />
									<input type="hidden" name="windowSeconds" value={a.condition.windowSeconds} />
									<input type="hidden" name="channel" value={a.channel} />
									{#if !a.enabled}<input type="hidden" name="enabled" value="" />{/if}
									{#if a.enabled}<input type="hidden" name="enabled" value="on" />{/if}
								{#if a.condition.baselineRate != null}
									<input type="hidden" name="baselineRate" value={a.condition.baselineRate} />
								{/if}
									<Button type="submit" size="sm" {pending}>{a.enabled ? 'Disable' : 'Enable'}</Button>
								</form>
								<form method="POST" action="?/remove" use:enhance={withPending((v) => (pending = v))}>
									<input type="hidden" name="id" value={a.id} />
									<Button type="submit" variant="danger" size="sm" {pending}>Delete</Button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Section>

	{#if data.workspaceAlerts.length}
		<Section title="Workspace alerts" lede="Managed at the workspace level; shown here as they cover this project too.">
			<TableWrap label="Workspace alerts">
				<table class="fr">
					<thead><tr><th>Name</th><th>Condition</th><th>Threshold</th><th>Channel</th><th>Enabled</th></tr></thead>
					<tbody>
						{#each data.workspaceAlerts as a (a.id)}
							<tr>
								<td>{a.name}</td>
								<td>{data.conditionLabels[a.condition.type]}</td>
								<td class="num">{a.condition.threshold} {unitFor(a.condition.type)}</td>
								<td>{a.channel}</td>
								<td><Badge tone={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'On' : 'Off'}</Badge></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableWrap>
		</Section>
	{/if}

	<Section title="Event history" lede="Every trigger for this project's alerts, newest first.">
		<TableWrap label="Alert events">
			<table class="fr">
				<thead>
					<tr><th>Triggered</th><th>Alert</th><th>Value</th><th>State</th><th>Message</th><th>Resolved</th></tr>
				</thead>
				<tbody>
					{#each data.events as e (e.id)}
						<tr>
							<td class="num">{formatDateTime(e.triggeredAt)}</td>
							<td>{e.alertName}</td>
							<td class="num">{e.value}</td>
							<td><Badge tone={eventTone[e.state] ?? 'neutral'}>{e.state}</Badge></td>
							<td>{e.message}</td>
							<td class="num">{e.resolvedAt ? formatDateTime(e.resolvedAt) : '—'}</td>
						</tr>
					{:else}
						<tr><td colspan="6">No events yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Section>
</UxState>

<style>
	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		align-items: flex-end;
		margin-bottom: var(--space-lg);
	}
	.grid :global(.field) {
		width: 9.5rem;
	}
	.actions {
		display: flex;
		align-items: center;
	}
	.row-actions {
		display: flex;
		gap: var(--space-xs);
	}
</style>
