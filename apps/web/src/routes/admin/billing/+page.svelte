<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCost, formatDate, formatDateTime } from '$lib/format';
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
		TableWrap
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Revenue"
	lede="The credit ledger platform-wide, with invoices and manual adjustments. The ledger is the record; account balances are a cache of it."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.posted}
	<div class="fr-feedback"><Alert tone="success">Posting {form.id} landed.</Alert></div>
{/if}
{#if form?.already}
	<div class="fr-feedback">
		<Alert tone="info">already posted (idempotent retry) — nothing was double-counted.</Alert>
	</div>
{/if}
{#if form?.invoiceCreated}
	<div class="fr-feedback"><Alert tone="success">Invoice {form.invoiceCreated} created.</Alert></div>
{/if}
{#if form?.invoiceStatus}
	<div class="fr-feedback"><Alert tone="success">Invoice {form.invoiceStatus}.</Alert></div>
{/if}
{#if form?.accountStatus}
	<div class="fr-feedback">
		<Alert tone="success">Billing account status set to {form.accountStatus}.</Alert>
	</div>
{/if}
<Guide id="admin-billing" />
<div class="fr-stats">
	{#each data.totals as t (t.type)}
		<StatCard label={t.type} value={formatCost(BigInt(t.totalMicro))} />
	{:else}
		<StatCard label="ledger" value={formatCost(0n)} />
	{/each}
</div>
<Card>
	<h2 class="first">Manual adjustment</h2>
	<form method="POST" action="?/adjust" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Billing account">
				<Select name="billing_account" required>
					<option value="">Choose…</option>
					{#each data.accounts as a (a.id)}
						<option value={a.id}>{a.workspaceName} ({a.currency})</option>
					{/each}
				</Select>
			</Field>
			<Field label="Type">
				<Select name="type">
					{#each data.adjustTypes as t (t)}<option value={t}>{t}</option>{/each}
				</Select>
			</Field>
			<Field label="Amount" hint="Signed dollars, e.g. 25.50 or -10. Max 6 decimals.">
				<Input name="amount" placeholder="25.50" required />
			</Field>
			<Field label="Idempotency key" hint="Optional. A repeated key posts exactly once.">
				<Input name="idempotencyKey" placeholder="manual:2026-09-acme-credit" />
			</Field>
		</div>
		<Field label="Description" hint="Why this adjustment exists. Audited.">
			<Input name="description" placeholder="Goodwill credit for 2026-09 outage" required />
		</Field>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Post adjustment</Button>
		</div>
	</form>
</Card>
<TableWrap label="Billing accounts">
	<table class="fr">
		<thead>
			<tr>
				<th>Workspace</th><th>Status</th><th>Balance (cache)</th><th>Ledger sum</th>
				<th>Warn at</th><th>Hard stop at</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.accounts as a (a.id)}
				<tr>
					<td>{a.workspaceName}</td>
					<td>
						<Badge tone={a.status === 'active' ? 'success' : a.status === 'suspended' ? 'warning' : 'neutral'}>
							{a.status}
						</Badge>
					</td>
					<td class="num" title="Cache of the ledger sum">{formatCost(BigInt(a.balanceMicro), a.currency)}</td>
					<td class="num">{formatCost(BigInt(a.ledgerSumMicro), a.currency)}</td>
					<td class="num">{formatCost(BigInt(a.warningThresholdMicro), a.currency)}</td>
					<td class="num">{formatCost(BigInt(a.hardStopThresholdMicro), a.currency)}</td>
					<td class="fr-actions">
						<form method="POST" action="?/setAccountStatus" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={a.id} />
							<Select name="status" size="sm" aria-label="Status for {a.workspaceName}">
								{#each data.accountStatuses as s (s)}
									<option value={s} selected={s === a.status}>{s}</option>
								{/each}
							</Select>
							<Button type="submit" {pending} aria-label="Set status for {a.workspaceName}">
								Set
							</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="7"><EmptyState title="No billing accounts yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<Card>
	<h2 class="first">Create invoice</h2>
	<form method="POST" action="?/createInvoice" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Billing account">
				<Select name="billing_account" required>
					<option value="">Choose…</option>
					{#each data.accounts as a (a.id)}
						<option value={a.id}>{a.workspaceName}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Number"><Input name="number" placeholder="INV-202609-000123" required /></Field>
			<Field label="Period start"><Input name="period_start" type="date" required /></Field>
			<Field label="Period end"><Input name="period_end" type="date" required /></Field>
			<Field label="Amount (USD)"><Input name="amount" placeholder="120.00" required /></Field>
			<Field label="Status">
				<Select name="status">
					{#each data.invoiceStatuses as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create invoice</Button>
		</div>
	</form>
</Card>
<TableWrap label="Invoices">
	<table class="fr">
		<thead>
			<tr>
				<th>Number</th><th>Workspace</th><th>Period</th><th>Amount</th><th>Status</th>
				<th>Issued</th><th>Paid</th><th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.invoices as iv (iv.id)}
				<tr>
					<td><code>{iv.number}</code></td>
					<td>{iv.workspaceName}</td>
					<td class="num">{formatDate(iv.periodStart)} → {formatDate(iv.periodEnd)}</td>
					<td class="num">{formatCost(BigInt(iv.amountMicro), iv.currency)}</td>
					<td>
						<Badge tone={iv.status === 'paid' ? 'success' : iv.status === 'void' || iv.status === 'uncollectible' ? 'danger' : 'warning'}>
							{iv.status}
						</Badge>
					</td>
					<td class="num">{iv.issuedAt ? formatDateTime(iv.issuedAt) : '—'}</td>
					<td class="num">{iv.paidAt ? formatDateTime(iv.paidAt) : '—'}</td>
					<td class="fr-actions">
						<form method="POST" action="?/setInvoiceStatus" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={iv.id} />
							<Select name="status" size="sm" aria-label="Status for {iv.number}">
								{#each data.invoiceStatuses as s (s)}
									<option value={s} selected={s === iv.status}>{s}</option>
								{/each}
							</Select>
							<Button type="submit" {pending} aria-label="Set status for {iv.number}">Set</Button>
						</form>
					</td>
				</tr>
			{:else}
				<tr><td colspan="8"><EmptyState title="No invoices yet" /></td></tr>
			{/each}
		</tbody>
	</table>
</TableWrap>
<h2>Credit ledger — newest {data.recent.length}</h2>
<p class="muted">
	Every posting is signed micro-units. The ledger is the record; the account balance column is a
	cache of its sum.
</p>
<TableWrap label="Credit ledger">
	<table class="fr">
		<thead>
			<tr>
				<th>When</th><th>Workspace</th><th>Type</th><th>Amount</th><th>Request</th>
				<th>Description</th><th>By</th>
			</tr>
		</thead>
		<tbody>
			{#each data.recent as r (r.id)}
				<tr>
					<td class="num">{formatDateTime(r.createdAt)}</td>
					<td>{r.workspaceName}</td>
					<td><Badge tone={r.type === 'usage_charge' ? 'neutral' : 'info'}>{r.type}</Badge></td>
					<td class="num">{formatCost(BigInt(r.amountMicro), r.currency)}</td>
					<td>{#if r.requestId}<code>{r.requestId}</code>{:else}—{/if}</td>
					<td>{r.description ?? '—'}</td>
					<td>{r.createdBy ?? 'system'}</td>
				</tr>
			{:else}
				<tr><td colspan="7"><EmptyState title="No ledger postings yet" /></td></tr>
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
