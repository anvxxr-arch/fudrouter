<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { formatCost, formatDate, formatDateTime, formatTokens } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Facts,
		Field,
		Guide,
		Input,
		PageHeader,
		StatCard,
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));

	const policy = $derived(data.key.policy as Record<string, unknown>);
	const policyFacts = $derived([
		{
			term: 'Endpoints',
			detail: Array.isArray(policy.endpoints) && policy.endpoints.length
				? (policy.endpoints as string[]).join(', ')
				: 'inherit'
		},
		{
			term: 'Models',
			detail: Array.isArray(policy.models) && policy.models.length
				? (policy.models as string[]).join(', ')
				: 'inherit'
		},
		{
			term: 'Aliases',
			detail: Array.isArray(policy.aliases) && policy.aliases.length
				? (policy.aliases as string[]).join(', ')
				: 'inherit'
		},
		{
			term: 'IP allowlist',
			detail: Array.isArray(policy.ip_allowlist) && policy.ip_allowlist.length
				? (policy.ip_allowlist as string[]).join(', ')
				: 'inherit'
		},
		{ term: 'Requests per minute', detail: policy.rpm !== undefined ? String(policy.rpm) : 'inherit' },
		{ term: 'Tokens per minute', detail: policy.tpm !== undefined ? String(policy.tpm) : 'inherit' },
		{
			term: 'Concurrent requests',
			detail: policy.concurrency !== undefined ? String(policy.concurrency) : 'inherit'
		},
		{
			term: 'Daily spend cap',
			detail:
				policy.daily_spend_micro !== undefined
					? formatCost(BigInt(policy.daily_spend_micro as number))
					: 'inherit'
		},
		{
			term: 'Monthly spend cap',
			detail:
				policy.monthly_spend_micro !== undefined
					? formatCost(BigInt(policy.monthly_spend_micro as number))
					: 'inherit'
		}
	]);
</script>

<PageHeader
	title={data.key.name}
	lede={`API key in ${data.projectName}. Rotate reissues the secret; the old one stops working immediately.`}
>
	{#snippet actions()}
		<p class="muted">
			<a
				href={resolve('/(app)/dashboard/projects/[projectId]/keys', { projectId: data.projectId })}
				>← All project keys</a
			>
		</p>
	{/snippet}
</PageHeader>

{#if form?.created}
	<div class="fr-feedback">
		<Alert tone="success">
			<strong>New secret — copy it now, it is shown once.</strong>
			<code class="secret">{form.created}</code>
			<span>The previous secret stopped working when this one was issued.</span>
		</Alert>
	</div>
{/if}
{#if form?.revoked}
	<div class="fr-feedback"><Alert tone="danger">Key “{form.revoked}” revoked. Calls with it are rejected from now on.</Alert></div>
{/if}
{#if form?.enabled}
	<div class="fr-feedback"><Alert tone="success">Key “{form.enabled}” enabled.</Alert></div>
{/if}
{#if form?.disabled}
	<div class="fr-feedback"><Alert tone="success">Key “{form.disabled}” disabled.</Alert></div>
{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}

<div class="narrow">
	<Card>
		<h2>Key</h2>
		<Facts
			items={[
				{ term: 'Prefix', detail: `sk-ar-${data.key.prefix}…` },
				{ term: 'Project', detail: data.projectName },
				{ term: 'Environment', detail: data.environmentName ?? '—' },
				{ term: 'Status', detail: data.key.status },
				{ term: 'Created', detail: formatDateTime(data.key.createdAt) },
				{ term: 'Last used', detail: data.key.lastUsedAt ? formatDateTime(data.key.lastUsedAt) : 'never' },
				{ term: 'Expires', detail: data.key.expiresAt ? formatDate(data.key.expiresAt) : 'never' }
			]}
		/>
	</Card>

	<Card>
		<h2>Policy</h2>
		<p class="muted">“inherit” means the next scope up decides (spec §7) — a missing field is not unlimited.</p>
		<Facts items={policyFacts} />
	</Card>

	<Card>
		<h2>Rotate</h2>
		<p class="muted">
			Issues a new secret on this same key. The current secret stops working immediately. The new
			secret is shown once.
		</p>
		<form method="POST" action="?/rotate" use:enhance={track} class="stack">
			<Field label={`Type “${data.key.name}” to confirm`} hint="Exact name, including case.">
				<Input name="confirm" autocomplete="off" required />
			</Field>
			<Button type="submit" {pending}>Rotate key</Button>
		</form>
	</Card>

	<Card>
		<h2>{data.key.status === 'active' ? 'Disable' : 'Enable'}</h2>
		<p class="muted">
			{data.key.status === 'active'
				? 'A disabled key is rejected by the router but stays listed here, and can be enabled again.'
				: data.key.status === 'revoked'
					? 'A revoked key cannot be enabled again — create a new one instead.'
					: 'Enabling lets this key call the router again.'}
		</p>
		{#if data.key.status !== 'revoked'}
			<form
				method="POST"
				action={data.key.status === 'active' ? '?/disable' : '?/enable'}
				use:enhance={track}
				class="stack"
			>
				<Field label={`Type “${data.key.name}” to confirm`} hint="Exact name, including case.">
					<Input name="confirm" autocomplete="off" required />
				</Field>
				<Button type="submit" {pending}>
					{data.key.status === 'active' ? 'Disable key' : 'Enable key'}
				</Button>
			</form>
		{/if}
	</Card>

	<Card>
		<h2>Revoke</h2>
		<p class="muted">
			Revoking is final: calls with this key are rejected from now on and it cannot be re-enabled.
			The usage history below stays.
		</p>
		{#if data.key.status !== 'revoked'}
			<form method="POST" action="?/revoke" use:enhance={track} class="stack">
				<Field label={`Type “${data.key.name}” to confirm`} hint="Exact name, including case.">
					<Input name="confirm" autocomplete="off" required />
				</Field>
				<Button type="submit" variant="danger" {pending}>Revoke key</Button>
			</form>
		{:else}
			<p class="muted">Already revoked{data.key.revokedAt ? ` on ${formatDateTime(data.key.revokedAt)}` : ''}.</p>
		{/if}
	</Card>

	<Card>
		<h2>Delete key</h2>
		<p class="muted">
			Removes the row entirely. The request history stays in the ledger, anonymised. An active key
			must be revoked or disabled first — or tick “force”.
		</p>
		<form method="POST" action="?/delete" use:enhance={track} class="stack">
			<Field label={`Type “${data.key.name}” to confirm`} hint="Exact name, including case.">
				<Input name="confirm" autocomplete="off" required />
			</Field>
			{#if data.key.status === 'active'}
				<label class="check">
					<input type="checkbox" name="force" value="yes" />
					Force: delete even though the key is still active
				</label>
			{/if}
			<Button type="submit" variant="danger" {pending}>Delete key</Button>
		</form>
	</Card>
</div>

<Guide id="keys-detail" />

<h2>Usage</h2>
<section class="fr-stats">
	<StatCard label="Requests" value={formatTokens(data.totals.requests)} />
	<StatCard label="Successes" value={formatTokens(data.totals.successes)} />
	<StatCard label="Tokens in" value={formatTokens(data.totals.tokensIn)} />
	<StatCard label="Tokens out" value={formatTokens(data.totals.tokensOut)} />
	<StatCard label="Cost" value={formatCost(BigInt(data.totals.cost))} />
</section>

<h2>Last requests</h2>
<TableWrap label="Last requests">
	<table class="fr">
		<thead>
			<tr><th>When</th><th>Model</th><th>Status</th><th>Cost</th></tr>
		</thead>
		<tbody>
			{#each data.recent as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.requestedModel ?? '—'}</td>
					<td>
						<Badge tone={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
					</td>
					<td class="num">{formatCost(r.cost)}</td>
				</tr>
			{:else}
				<tr><td colspan="4"><EmptyState title="No requests yet" hint="Call the router with this key." /></td></tr>
			{/each}
		</tbody>
	</table></TableWrap
>

<style>
	.secret {
		display: block;
		margin-top: var(--space-sm);
		word-break: break-all;
	}
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.check {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		font-size: var(--text-sm);
	}
	.narrow {
		max-width: 34rem;
	}
</style>
