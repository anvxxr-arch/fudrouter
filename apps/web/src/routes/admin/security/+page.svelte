<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Badge,
		Button,
		ButtonLink,
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
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	function num(v: unknown): number {
		return Number(v ?? 0);
	}
</script>
<PageHeader
	title="Security"
	lede="Threshold rules over request and audit traffic. SQL counts, not inference: every signal names the count that tripped it."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Rule “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Rule updated.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Rule deleted.</Alert></div>
{/if}
<nav class="subpages" aria-label="Security sections">
	<ButtonLink href={resolve('/admin/security/abuse')}>Abuse signals</ButtonLink>
	<ButtonLink href={resolve('/admin/security/blocked-ips')}>Blocked IPs</ButtonLink>
	<ButtonLink href={resolve('/admin/security/blocked-keys')}>Blocked keys</ButtonLink>
	<ButtonLink href={resolve('/admin/security/audit-log')}>Audit log</ButtonLink>
</nav>
<Card>
	<h2 class="first">Add signal rule</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="auth failure burst" required /></Field>
			<Field label="Kind">
				<Select name="kind">
					{#each data.kinds as k (k)}
						<option value={k}>{k}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Threshold" hint="Count that trips the rule.">
				<Input name="threshold" type="number" value="10" min="0" required />
			</Field>
			<Field label="Window (seconds)" hint="Bucket the rule is evaluated over.">
				<Input name="window_seconds" type="number" value="3600" min="1" required />
			</Field>
			<Field label="Action">
				<Select name="action">
					{#each data.actions as a (a)}
						<option value={a}>{a}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Enabled" hint="Off keeps the rule without evaluating it.">
				<input type="checkbox" name="enabled" checked />
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create rule</Button>
		</div>
	</form>
</Card>
<Guide id="admin-security" />
<TableWrap label="Signal rules">
	<table class="fr">
		<thead>
			<tr><th>Name</th><th>Kind</th><th>Threshold</th><th>Window</th><th>Action</th><th>Enabled</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.rules as r (r.id)}
				<tr>
					<td>{r.name}</td>
					<td><Badge tone="info">{r.kind}</Badge></td>
					<td class="num">{num(r.config.threshold)}</td>
					<td class="num">{num(r.config.window_seconds)}s</td>
					<td><Badge tone={r.action === 'block' ? 'danger' : 'neutral'}>{r.action}</Badge></td>
					<td><Badge tone={r.enabled ? 'success' : 'warning'}>{r.enabled ? 'on' : 'off'}</Badge></td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(r.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={r.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete rule {r.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === r.id}
					<tr class="edit-row">
						<td colspan="7">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={r.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={r.name} required /></Field>
									<Field label="Kind">
										<Select name="kind">
											{#each data.kinds as k (k)}
												<option value={k} selected={r.kind === k}>{k}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Threshold">
										<Input name="threshold" type="number" value={num(r.config.threshold)} min="0" required />
									</Field>
									<Field label="Window (seconds)">
										<Input
											name="window_seconds"
											type="number"
											value={num(r.config.window_seconds)}
											min="1"
											required
										/>
									</Field>
									<Field label="Action">
										<Select name="action">
											{#each data.actions as a (a)}
												<option value={a} selected={r.action === a}>{a}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Enabled">
										<input type="checkbox" name="enabled" checked={r.enabled} />
									</Field>
								</div>
								<div class="submit">
									<Button type="submit" {pending} variant="primary">Save rule</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="7"><EmptyState title="No signal rules yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<style>
	.subpages {
		display: flex;
		gap: var(--space-md);
		margin: var(--space-md) 0;
		flex-wrap: wrap;
	}
</style>
