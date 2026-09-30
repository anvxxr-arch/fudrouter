<script lang="ts">
	import { resolve } from '$app/paths';
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
		StatCard,
		TableWrap,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatDateTime } from '$lib/format';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	// The one-time secret is held here so it survives the follow-up renders of the
	// same action result; it is never part of `data`, so a reload cannot show it.
	let shownOnce = $state<{ id: string; name: string; secret: string } | null>(null);
	$effect(() => {
		const once = form?.secretOnce;
		if (once) shownOnce = { id: once.id, name: once.name, secret: once.secret };
	});
	const statusTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		healthy: 'success',
		rate_limited: 'warning',
		cooldown: 'warning',
		auth_failed: 'danger',
		invalid: 'danger',
		disabled: 'neutral',
		unknown: 'neutral'
	};
	const poolTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
		Healthy: 'success',
		'Rate Limited': 'warning',
		Cooldown: 'warning',
		Invalid: 'danger',
		Disabled: 'neutral',
		Unknown: 'neutral'
	};
</script>

<PageHeader
	title="Credential pool — {data.provider.name}"
	lede="Accounts this provider can authenticate with. Secrets are encrypted at rest and shown exactly once."
/>
<p class="muted">
	<a href={resolve('/admin/providers/[id]', { id: data.provider.id })}>← {data.provider.name}</a>
</p>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Credential saved.</Alert></div>
{/if}
{#if form?.revoked}
	<div class="fr-feedback"><Alert tone="success">Credential revoked.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Credential deleted.</Alert></div>
{/if}
{#if form?.message}
	<div class="fr-feedback"><Alert tone="success">{form.message}</Alert></div>
{/if}

{#if shownOnce}
	<div class="fr-feedback">
		<Alert tone="warning">
			<strong>Copy it now — it will not be shown again.</strong>
			<code class="once">{shownOnce.secret}</code> ({shownOnce.name})
			<Button type="button" onclick={() => (shownOnce = null)}>I saved it</Button>
		</Alert>
	</div>
{/if}

<Card>
	<h2 class="first">Pool</h2>
	<div class="stats">
		<StatCard label="Total" value={data.pool.total} />
		{#each Object.entries(data.pool.buckets) as [bucket, n] (bucket)}
			<StatCard label={bucket} value={n} tone={poolTone[bucket] ?? 'neutral'} />
		{/each}
	</div>
</Card>

<Card>
	<h2 class="first">Filter</h2>
	<form method="GET" class="filters">
		<div class="pick">
			<Field label="Connection">
				<Select name="connection" value={data.filters.connection}>
					<option value="">All</option>
					{#each data.connections as c (c.id)}
						<option value={c.id} selected={c.id === data.filters.connection}>{c.name}</option>
					{/each}
				</Select>
			</Field>
		</div>
		<div class="pick">
			<Field label="Status">
				<Select name="status" value={data.filters.status}>
					<option value="">All</option>
					{#each data.statuses as s (s)}
						<option value={s} selected={s === data.filters.status}>{s}</option>
					{/each}
				</Select>
			</Field>
		</div>
		<div class="pick">
			<Field label="Last used within">
				<Select name="lastUsed" value={data.filters.lastUsed}>
					<option value="">Any time</option>
					{#each data.lastUsedAges as h (h)}
						<option value={h} selected={h === data.filters.lastUsed}>{h}h</option>
					{/each}
				</Select>
			</Field>
		</div>
		<Button type="submit">Filter</Button>
	</form>
</Card>

<Card>
	<h2 class="first">Add credential</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="prod account" required /></Field>
			<Field label="Connection">
				<Select name="connectionId">
					{#each data.connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
				</Select>
			</Field>
			<Field label="Secret" hint="API key or token. Stored encrypted, shown back once.">
				<Input name="secret" type="password" required />
			</Field>
			<Field label="Priority"><Input name="priority" type="number" value="100" /></Field>
			<Field label="Weight"><Input name="weight" type="number" value="100" /></Field>
		</div>
		<Field label="Default headers" hint="One per line, Name: value.">
			<Textarea name="headers" rows="2" placeholder="x-client-version: 0.1.0"></Textarea>
		</Field>
		<Field label="Metadata (JSON)" hint="Labels only — never put a secret here.">
			<Textarea name="metadata" rows="2" placeholder={'{}'}></Textarea>
		</Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary" disabled={data.connections.length === 0}>
				Create credential
			</Button>
		</div>
	</form>
	{#if data.connections.length === 0}
		<EmptyState
			title="Add a connection first"
			hint="A credential hangs off one connection, which carries the endpoint."
		/>
	{/if}
</Card>

<Guide id="admin-provider-credentials" />

<TableWrap label="Credentials">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Connection</th><th>Status</th><th>Priority</th><th>Weight</th>
				<th>Last used</th><th>Last success</th><th>Cooldown</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.credentials as c (c.id)}
				<tr>
					<td>{c.name}</td>
					<td>{c.connectionName}</td>
					<td><Badge tone={statusTone[c.status] ?? 'neutral'}>{c.status}</Badge></td>
					<td class="num">{c.priority}</td>
					<td class="num">{c.weight}</td>
					<td class="num">{c.lastUsedAt ? formatDateTime(new Date(c.lastUsedAt)) : 'never'}</td>
					<td class="num">{c.lastSuccessAt ? formatDateTime(new Date(c.lastSuccessAt)) : '—'}</td>
					<td class="num"
						>{c.cooldownUntil ? formatDateTime(new Date(c.cooldownUntil)) : '—'}</td
					>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(c.id)}>Edit</Button>
						<form method="POST" action="?/disable" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<input type="hidden" name="confirm" value="on" />
							<Button type="submit" {pending} aria-label="Disable credential {c.name}">Disable</Button>
						</form>
						<form method="POST" action="?/enable" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<input type="hidden" name="confirm" value="on" />
							<Button type="submit" {pending} aria-label="Enable credential {c.name}">Enable</Button>
						</form>
						<form method="POST" action="?/rotate" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<input type="hidden" name="confirm" value="on" />
							<Input name="secret" type="password" placeholder="new secret" required />
							<Button type="submit" {pending} variant="danger" aria-label="Rotate credential {c.name}">
								Rotate
							</Button>
						</form>
						<form method="POST" action="?/revoke" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<input type="hidden" name="confirm" value="on" />
							<Button type="submit" {pending} variant="danger" aria-label="Revoke credential {c.name}">
								Revoke
							</Button>
						</form>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={c.id} />
							<input type="hidden" name="confirm" value="on" />
							<Button type="submit" {pending} variant="danger" aria-label="Delete credential {c.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === c.id}
					<tr class="edit-row">
						<td colspan="9">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={c.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={c.name} required /></Field>
									<Field label="Priority"><Input name="priority" type="number" value={c.priority} /></Field>
									<Field label="Weight"><Input name="weight" type="number" value={c.weight} /></Field>
									<Field label="Status" hint="Leave as-is to keep the observed status.">
										<Select name="status">
											<option value="">unchanged</option>
											{#each data.statuses as s (s)}
												<option value={s} selected={s === c.status}>{s}</option>
											{/each}
										</Select>
									</Field>
								</div>
								<Field label="Metadata (JSON)">
									<Textarea name="metadata" rows="2">{JSON.stringify(c.metadata)}</Textarea>
								</Field>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save credential {c.name}">
										Save
									</Button>
								</div>
							</form>
							<p class="muted">
								The secret cannot be edited — rotate it. Added {c.createdAt
									? formatDateTime(new Date(c.createdAt))
									: '—'}.
							</p>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="9"><EmptyState title="No credentials match this filter" /></td></tr>
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
	.filters {
		display: flex;
		gap: var(--space-md);
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.pick {
		width: 12rem;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--space-md);
	}
	.once {
		overflow-wrap: anywhere;
	}
</style>
