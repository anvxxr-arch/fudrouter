<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTime } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		ButtonLink,
		EmptyState,
		Field,
		Guide,
		PageHeader,
		Select,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
		done: 'success',
		failed: 'danger',
		cancelled: 'neutral',
		running: 'info',
		pending: 'warning'
	};
	function payload(value: unknown): string {
		const s = JSON.stringify(value, null, 2);
		return s.length > 300 ? s.slice(0, 300) + '…' : s;
	}
</script>

<PageHeader title="Job queue" lede="Every background job with status, attempts and the error that stopped it." />
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.retried}<div class="fr-feedback"><Alert tone="success">Job {form.retried} requeued.</Alert></div>{/if}
{#if form?.cancelled}<div class="fr-feedback"><Alert tone="success">Job {form.cancelled} cancelled.</Alert></div>{/if}
<Guide id="admin-system-jobs" />
<form class="filters" method="GET">
	<div class="pick">
		<Field label="Status">
			<Select name="status">
				<option value="" selected={!data.status}>All</option>
				{#each data.statuses as s (s)}
					<option value={s} selected={data.status === s}>{s}</option>
				{/each}
			</Select>
		</Field>
	</div>
	<div class="pick">
		<Field label="Type">
			<Select name="type">
				<option value="" selected={!data.type}>All</option>
				{#each data.types as t (t)}
					<option value={t} selected={data.type === t}>{t}</option>
				{/each}
			</Select>
		</Field>
	</div>
	<Button type="submit">Filter</Button>
	<ButtonLink href="?">Reset</ButtonLink>
</form>
<p class="muted">Showing the latest {data.rows.length} jobs (max 100).</p>
<TableWrap label="Job queue">
	<table class="fr">
		<thead>
			<tr>
				<th>Job</th><th>Type</th><th>Status</th><th>Attempts</th><th>Available</th><th>Started</th><th
					>Finished</th
				><th>Error</th><th>Payload</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.rows as j (j.id)}
				<tr>
					<td class="mono">{j.id}</td>
					<td>{j.type}</td>
					<td><Badge tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status}</Badge></td>
					<td class="num">{j.attempts} / {j.maxAttempts}</td>
					<td class="num">{formatDateTime(j.availableAt)}</td>
					<td class="num">{j.startedAt ? formatDateTime(j.startedAt) : '—'}</td>
					<td class="num">{j.finishedAt ? formatDateTime(j.finishedAt) : '—'}</td>
					<td class="muted">{j.error ?? '—'}</td>
					<td><pre class="mono payload">{payload(j.payload)}</pre></td>
					<td class="fr-actions">
						{#if (data.retryable as readonly string[]).includes(j.status)}
							<form method="POST" action="?/retry" use:enhance={track} class="fr-inline">
								<input type="hidden" name="id" value={j.id} />
								<Button type="submit" {pending} aria-label="Retry job {j.id}">Retry</Button>
							</form>
						{/if}
						{#if (data.cancellable as readonly string[]).includes(j.status)}
							<form method="POST" action="?/cancel" use:enhance={track} class="fr-inline">
								<input type="hidden" name="id" value={j.id} />
								<Button
									type="submit"
									{pending}
									variant="danger"
									aria-label="Cancel job {j.id}">Cancel</Button
								>
							</form>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="10"><EmptyState title="No jobs match" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	.filters {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		margin: var(--space-md) 0;
	}
	.pick {
		width: 12rem;
	}
	.mono {
		font-family: var(--font-mono, monospace);
	}
	.payload {
		margin: 0;
		max-width: 18rem;
		overflow-x: auto;
		font-size: var(--text-caption);
	}
</style>
