<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const SEVERITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
		critical: 'danger',
		major: 'warning',
		minor: 'neutral'
	};
	const STATUS_TONE: Record<string, 'info' | 'success' | 'warning'> = {
		investigating: 'warning',
		identified: 'info',
		monitoring: 'info',
		resolved: 'success'
	};
</script>

<PageHeader
	title="Incidents"
	lede="One row per incident with a timeline of updates. The status page reads these."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}<div class="fr-feedback"><Alert tone="success">Incident “{form.created}” opened.</Alert></div>{/if}
{#if form?.updated}<div class="fr-feedback"><Alert tone="success">Incident updated.</Alert></div>{/if}
{#if form?.deleted}<div class="fr-feedback"><Alert tone="success">Incident deleted.</Alert></div>{/if}
<Guide id="admin-incidents" />
<Card>
	<h2 class="fr-label">Open an incident</h2>
	<form method="POST" action="?/create" use:enhance={track} class="row">
		<Field label="Title"><Input name="title" required placeholder="Elevated error rate" /></Field>
		<Field label="Component"><Input name="component" required placeholder="openai" /></Field>
		<Field label="Severity">
			<Select name="severity">
				{#each data.severities as s (s)}
					<option value={s} selected={s === 'minor'}>{s}</option>
				{/each}
			</Select>
		</Field>
		<Button type="submit" {pending}>Open incident</Button>
	</form>
</Card>
{#each data.incidents as i (i.id)}
	<Card>
		<div class="head">
			<h2 class="fr-label">{i.title}</h2>
			<Badge tone={SEVERITY_TONE[i.severity] ?? 'neutral'}>{i.severity}</Badge>
			<Badge tone={STATUS_TONE[i.status] ?? 'info'}>{i.status}</Badge>
			<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
				<input type="hidden" name="id" value={i.id} />
				<Button type="submit" {pending} variant="danger" aria-label="Delete incident {i.title}">
					Delete
				</Button>
			</form>
		</div>
		<p class="muted">
			{i.component} · started {formatDateTime(i.startedAt)}{i.resolvedAt
				? ` · resolved ${formatDateTime(i.resolvedAt)}`
				: ''}
		</p>
		<h3 class="fr-label">Timeline (newest first)</h3>
		<ul class="timeline">
			{#each i.updates as u (u.id)}
				<li>
					<Badge tone={STATUS_TONE[u.status] ?? 'info'}>{u.status}</Badge>
					<span class="muted">{formatDateTime(u.createdAt)}</span>
					<p>{u.message}</p>
				</li>
			{:else}
				<li><EmptyState title="No updates yet" /></li>
			{/each}
		</ul>
		<form method="POST" action="?/update" use:enhance={track} class="row">
			<input type="hidden" name="id" value={i.id} />
			<Field label="Title"><Input name="title" value={i.title} required /></Field>
			<Field label="Component"><Input name="component" value={i.component} required /></Field>
			<Field label="Severity">
				<Select name="severity" aria-label="Severity for {i.title}">
					{#each data.severities as s (s)}
						<option value={s} selected={s === i.severity}>{s}</option>
					{/each}
				</Select>
			</Field>
			<Button type="submit" {pending}>Save</Button>
		</form>
		<form method="POST" action="?/addTimeline" use:enhance={track} class="row">
			<input type="hidden" name="id" value={i.id} />
			<Field label="Status">
				<Select name="status" aria-label="Status update for {i.title}">
					{#each data.statuses as s (s)}
						<option value={s} selected={s === i.status}>{s}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Message">
				<Textarea name="message" required rows="2" placeholder="What changed?" />
			</Field>
			<Button type="submit" {pending}>Add update</Button>
		</form>
	</Card>
{:else}
	<EmptyState title="No incidents" hint="Open one when something is wrong; the status page reads these." />
{/each}
<style>
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}
	.row {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: var(--space-md);
	}
	.timeline {
		list-style: none;
		padding: 0;
		margin: var(--space-sm) 0;
		display: grid;
		gap: var(--space-sm);
	}
	.timeline p {
		margin: var(--space-xs) 0 0;
	}
</style>
