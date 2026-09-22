<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCost, formatTokens } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		Card,
		EmptyState,
		Field,
		Input,
		PageHeader,
		Select
	} from '$lib/ui';
	import { withPending } from '$lib/forms';

	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));

	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
</script>

<PageHeader
	title="Client API keys"
	lede="Mint and limit keys on behalf of a client. Limits are stored per key; the data plane reads them."
/>

{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback">
		<Alert tone="success">
			<strong>Key created — copy it now, it is shown once.</strong>
			<code class="secret">{form.created}</code>
		</Alert>
	</div>
{/if}

<Card>
	<h2 class="first">Mint a key for a client</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Owner">
				<Select name="userId" required>
					{#each data.users as u (u.id)}
						<option value={u.id}>{u.email} ({u.role ?? 'user'})</option>
					{/each}
				</Select>
			</Field>
			<Field label="Name"><Input name="name" placeholder="client name" required /></Field>
			<Field label="Rate limit" hint="Requests per minute.">
				<Input name="rpm" type="number" min="0" placeholder="unlimited" />
			</Field>
			<Field label="Monthly cost cap" hint="USD per month.">
				<Input name="monthlyCap" type="number" min="0" step="0.01" placeholder="unlimited" />
			</Field>
		</div>
		<div class="submit"><Button type="submit" {pending} variant="primary">Create key</Button></div>
	</form>
</Card>

<div class="table-wrap">
<table class="fr">
	
		<thead>
			<tr>
				<th>Key</th><th>Owner</th><th>Status</th><th>Requests</th><th>Tokens</th><th>Cost</th>
				<th>Limits</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.keys as k (k.id)}
				<tr>
					<td>{k.name}<br /><code class="muted">sk-ar-{k.prefix}…</code></td>
					<td>{k.email}</td>
					<td>
						<Badge tone={k.revokedAt ? 'danger' : 'success'}>
							{k.revokedAt ? 'revoked' : 'active'}
						</Badge>
					</td>
					<td class="num">{formatTokens(k.usage.requests)}</td>
					<td class="num">{formatTokens(k.usage.tokensIn + k.usage.tokensOut)}</td>
					<td class="num">{formatCost(BigInt(k.usage.cost))}</td>
					<td class="num">
						{k.rpm ?? '∞'} rpm<br />{k.monthlyCapUsd ? '$' + k.monthlyCapUsd + '/mo' : 'no cap'}
					</td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(k.id)}>Limits</Button>
						{#if !k.revokedAt}
							<form method="POST" action="?/revoke" use:enhance={track} class="fr-inline">
								<input type="hidden" name="id" value={k.id} />
								<Button type="submit" {pending} variant="danger" aria-label="Revoke key {k.name}">
									Revoke
								</Button>
							</form>
						{/if}
					</td>
				</tr>
				{#if editing === k.id}
					<tr class="edit-row">
						<td colspan="8">
							<form method="POST" action="?/updateLimits" use:enhance={track}>
								<input type="hidden" name="id" value={k.id} />
								<div class="fr-grid">
									<Field label="Rate limit" hint="Requests per minute.">
										<Input name="rpm" type="number" min="0" value={k.rpm ?? ''} />
									</Field>
									<Field label="Monthly cost cap" hint="USD per month.">
										<Input
											name="monthlyCap"
											type="number"
											min="0"
											step="0.01"
											value={k.monthlyCapUsd}
										/>
									</Field>
								</div>
								<div class="submit">
									<Button
										type="submit"
										{pending}
										variant="primary"
										aria-label="Save limits for {k.name}"
									>
										Save limits
									</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="8"><EmptyState title="No keys yet" /></td></tr>
			{/each}
		</tbody>
	</table></div>

<style>
	
	h2.first {
		margin-top: 0;
	}
	.secret {
		display: block;
		margin-top: var(--fr-space-sm);
		word-break: break-all;
	}
	form {
		display: grid;
		gap: var(--fr-space-md);
	}</style>
