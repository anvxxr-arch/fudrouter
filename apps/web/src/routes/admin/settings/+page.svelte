<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCost } from '$lib/format';
	import {
		Alert,
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
</script>

<PageHeader
	title="Platform settings"
	lede="Platform-wide switches, retention, defaults and hard limits. Every change is audit-logged."
>
	{#snippet actions()}
		<ButtonLink href="/admin/settings/feature-flags">Feature flags</ButtonLink>
	{/snippet}
</PageHeader>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.saved}
	<div class="fr-feedback"><Alert tone="success">{form.saved} saved.</Alert></div>
{/if}
{#if data.maintenance}
	<div class="fr-feedback">
		<Alert tone="danger">
			Maintenance mode is ON — API requests are rejected platform-wide.
		</Alert>
	</div>
{/if}
<Guide id="admin-settings" />

<Card>
	<h2 class="first">General</h2>
	<form method="POST" action="?/updateGeneral" use:enhance={track}>
		<label class="check">
			<input type="checkbox" name="maintenance" checked={data.maintenance} />
			Maintenance mode — reject API requests while work is done
		</label>
		<label class="check">
			<input type="checkbox" name="generic_passthrough" checked={data.genericPassthrough} />
			Generic passthrough — forward requests to unmapped upstream models
		</label>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save general</Button>
		</div>
	</form>
</Card>

<Card>
	<h2 class="first">Registration</h2>
	<form method="POST" action="?/updateRegistration" use:enhance={track}>
		<label class="check">
			<input type="checkbox" name="registration" checked={data.registration} />
			Allow new user sign-ups
		</label>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save registration</Button>
		</div>
	</form>
</Card>

<Card>
	<h2 class="first">Retention</h2>
	<p class="muted">
		Whole days, 0 or more. Request content days of 0 means content is never captured (not
		retained).
	</p>
	<form method="POST" action="?/updateRetention" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Request metadata days" hint="0 = metadata not retained.">
				<Input
					name="request_metadata_days"
					type="number"
					min="0"
					value={data.retention.request_metadata_days}
					required
				/>
			</Field>
			<Field label="Request content days" hint="0 = content never captured (not retained).">
				<Input
					name="request_content_days"
					type="number"
					min="0"
					value={data.retention.request_content_days}
					required
				/>
			</Field>
			<Field label="System events days">
				<Input
					name="system_events_days"
					type="number"
					min="0"
					value={data.retention.system_events_days}
					required
				/>
			</Field>
			<Field label="Audit log days">
				<Input
					name="audit_logs_days"
					type="number"
					min="0"
					value={data.retention.audit_logs_days}
					required
				/>
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save retention</Button>
		</div>
	</form>
</Card>

<Card>
	<h2 class="first">Default routing policy</h2>
	<p class="muted">Used for requests with no workspace, project or environment policy.</p>
	<form method="POST" action="?/updateDefaultRouting" use:enhance={track}>
		<Field label="Policy">
			<Select name="policyId">
				<option value="" disabled selected={!data.defaultRoutingPolicyId}>Select a policy…</option>
				{#each data.policies as p (p.id)}
					<option value={p.id} selected={p.id === data.defaultRoutingPolicyId}
						>{p.name} ({p.strategy})</option
					>
				{/each}
			</Select>
		</Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save default policy</Button>
		</div>
	</form>
</Card>

<Card>
	<h2 class="first">Platform hard limits</h2>
	<p class="muted">Whole numbers, 0 or more. Also editable from Traffic.</p>
	<form method="POST" action="?/updateHardLimits" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Requests per minute"><Input name="rpm" type="number" min="0" value={data.hardLimits.rpm} required /></Field>
			<Field label="Tokens per minute"><Input name="tpm" type="number" min="0" value={data.hardLimits.tpm} required /></Field>
			<Field label="Concurrency"><Input name="concurrency" type="number" min="0" value={data.hardLimits.concurrency} required /></Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Save hard limits</Button>
		</div>
	</form>
</Card>

<Card>
	<h2 class="first">Billing defaults</h2>
	<p class="muted">
		Warning and hard-stop thresholds, applied to every billing account in one run.
	</p>
	<form method="POST" action="?/setBillingDefaults" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Warning threshold (USD)" hint="Warn the workspace at this spend.">
				<Input name="warningUsd" placeholder="10.00" required />
			</Field>
			<Field label="Hard-stop threshold (USD)" hint="Stop serving at this spend.">
				<Input name="hardStopUsd" placeholder="50.00" required />
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Apply to all accounts</Button>
		</div>
	</form>
	<TableWrap label="Billing accounts">
		<table class="fr">
			<thead>
				<tr><th>Workspace</th><th>Warning at</th><th>Hard stop at</th></tr>
			</thead>
			<tbody>
				{#each data.accounts as a (a.workspaceId)}
					<tr>
						<td><code>{a.workspaceId}</code></td>
						<td class="num">{formatCost(BigInt(a.warningMicro))}</td>
						<td class="num">{formatCost(BigInt(a.hardStopMicro))}</td>
					</tr>
				{:else}
					<tr><td colspan="3"><EmptyState title="No billing accounts yet" /></td></tr>
				{/each}
			</tbody>
		</table>
	</TableWrap>
</Card>

<style>
	h2.first {
		margin-top: 0;
	}
	form {
		display: grid;
		gap: var(--space-md);
	}
	.check {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}
	.submit {
		display: flex;
		gap: var(--space-md);
	}
</style>
