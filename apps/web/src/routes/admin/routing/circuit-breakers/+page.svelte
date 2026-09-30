<script lang="ts">
	import { enhance } from '$app/forms';
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
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	let target = $state<string>('provider');
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	function targetLabel(b: { target: string; targetId: string }): string {
		if (b.target === 'provider') {
			return data.providers.find((p) => p.id === b.targetId)?.name ?? b.targetId;
		}
		if (b.target === 'connection') {
			return data.connections.find((c) => c.id === b.targetId)?.name ?? b.targetId;
		}
		const m = data.models.find((m) => m.id === b.targetId);
		return m ? `${m.name} (${m.slug})` : b.targetId;
	}
</script>
<PageHeader
	title="Circuit breakers"
	lede="Trip a target closed after repeated failures. Config lives in Postgres; runtime state is best-effort from Valkey."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Circuit breaker for {form.created} created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Circuit breaker updated.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Circuit breaker deleted.</Alert></div>
{/if}
<Card>
	<h2 class="first">Add circuit breaker</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Target">
				<Select name="target" bind:value={target}>
					{#each data.targets as t (t)}<option value={t}>{t}</option>{/each}
				</Select>
			</Field>
			<Field label="Target id">
				<Select name="targetId">
					{#if target === 'provider'}
						{#each data.providers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					{:else if target === 'connection'}
						{#each data.connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					{:else}
						{#each data.models as m (m.id)}<option value={m.id}>{m.name} ({m.slug})</option>{/each}
					{/if}
				</Select>
			</Field>
			<Field label="Failure threshold"><Input name="failureThreshold" type="number" value="5" /></Field>
			<Field label="Window (seconds)"><Input name="windowSeconds" type="number" value="60" /></Field>
			<Field label="Open (ms)"><Input name="openMs" type="number" value="30000" /></Field>
			<Field label="Half-open probes"><Input name="halfOpenProbes" type="number" value="2" /></Field>
			<Field label="Enabled"><Input name="enabled" type="checkbox" checked /></Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create circuit breaker</Button>
		</div>
	</form>
</Card>
<Guide id="admin-routing-circuit-breakers" />
<TableWrap label="Circuit breakers">
	<table class="fr">
		<thead>
			<tr
				><th>Target</th><th>Name</th><th>Threshold</th><th>Window</th><th>Open</th><th
					>Probes</th
				><th>State</th><th>Actions</th></tr
			>
		</thead>
		<tbody>
			{#each data.breakers as b (b.id)}
				<tr>
					<td><Badge tone="neutral">{b.target}</Badge></td>
					<td>{targetLabel(b)}</td>
					<td class="num">{b.failureThreshold}</td>
					<td class="num">{b.windowSeconds}s</td>
					<td class="num">{b.openMs.toLocaleString()} ms</td>
					<td class="num">{b.halfOpenProbes}</td>
					<td><code>{b.state}</code></td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(b.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={b.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete breaker {targetLabel(b)}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === b.id}
					<tr class="edit-row">
						<td colspan="8">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={b.id} />
								<div class="fr-grid">
									<Field label="Failure threshold"
										><Input name="failureThreshold" type="number" value={b.failureThreshold} /></Field
									>
									<Field label="Window (seconds)"
										><Input name="windowSeconds" type="number" value={b.windowSeconds} /></Field
									>
									<Field label="Open (ms)"><Input name="openMs" type="number" value={b.openMs} /></Field>
									<Field label="Half-open probes"
										><Input name="halfOpenProbes" type="number" value={b.halfOpenProbes} /></Field
									>
									<Field label="Enabled"
										><Input name="enabled" type="checkbox" checked={b.enabled} /></Field
									>
								</div>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save breaker {targetLabel(b)}">
										Save
									</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="8"><EmptyState title="No circuit breakers yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
</style>
