<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Badge,
		Button,
		Card,
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
</script>
<PageHeader
	title="Environments"
	lede="Every project ships with development, staging and production. Add custom ones as you need them."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Environment “{form.created}” created.</Alert></div>
{/if}
{#if form?.saved}
	<div class="fr-feedback"><Alert tone="success">Environment “{form.saved}” saved.</Alert></div>
{/if}
{#if form?.enabled}
	<div class="fr-feedback"><Alert tone="success">Environment “{form.enabled}” enabled.</Alert></div>
{/if}
{#if form?.disabled}
	<div class="fr-feedback"><Alert tone="success">Environment “{form.disabled}” disabled.</Alert></div>
{/if}
<div class="narrow">
	<Card>
		<h2>Add an environment</h2>
		<form method="POST" action="?/create" use:enhance={track} class="stack">
			<Field label="Name" hint="Custom environments are type “custom”; slug is derived from the name.">
				<Input name="name" placeholder="QA" required />
			</Field>
			<Button type="submit" variant="primary" {pending}>Create environment</Button>
		</form>
	</Card>
</div>
<Guide id="environments" />
<h2>All environments</h2>
<TableWrap label="Environments">
	<table class="fr">
		<thead>
			<tr>
				<th>Name</th><th>Slug</th><th>Type</th><th>Status</th><th>Routing policy</th><th>Per environment</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.environments as e (e.id)}
				<tr>
					<td>{e.name}</td>
					<td><code>{e.slug}</code></td>
					<td>{e.type}</td>
					<td>
						<Badge tone={e.status === 'active' ? 'success' : 'warning'}>{e.status}</Badge>
					</td>
					<td>{e.routingPolicyName ?? '—'}</td>
					<td>
						<form method="POST" action="?/update" use:enhance={track} class="envform">
							<input type="hidden" name="environmentId" value={e.id} />
							<Field label="Routing policy">
								<Select name="routing_policy_id" value={e.routingPolicyId ?? ''}>
									<option value="">Inherit (none)</option>
									{#each data.policies as p (p.id)}
										<option value={p.id}>{p.name}</option>
									{/each}
								</Select>
							</Field>
							<Field label="Monthly budget (USD)">
								<Input name="monthly_budget_micro" value={e.budgetInput} placeholder="empty = none" />
							</Field>
							<div class="limits">
								<Field label="RPM">
									<Input name="rpm" value={e.rpm ?? ''} inputmode="numeric" placeholder="inherit" />
								</Field>
								<Field label="TPM">
									<Input name="tpm" value={e.tpm ?? ''} inputmode="numeric" placeholder="inherit" />
								</Field>
								<Field label="Concurrency">
									<Input
										name="concurrency"
										value={e.concurrency ?? ''}
										inputmode="numeric"
										placeholder="inherit"
									/>
								</Field>
							</div>
							<Button type="submit" {pending}>Save</Button>
						</form>
					</td>
					<td class="fr-actions">
						{#if e.status === 'active'}
							<form method="POST" action="?/disable" use:enhance={track}>
								<input type="hidden" name="environmentId" value={e.id} />
								<Button type="submit" variant="danger" {pending} aria-label="Disable {e.name}">
									Disable
								</Button>
							</form>
						{:else}
							<form method="POST" action="?/enable" use:enhance={track}>
								<input type="hidden" name="environmentId" value={e.id} />
								<Button type="submit" {pending} aria-label="Enable {e.name}">Enable</Button>
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table></TableWrap
>
<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.envform {
		display: grid;
		gap: var(--space-sm);
		min-width: 18rem;
	}
	.limits {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-sm);
	}
</style>
