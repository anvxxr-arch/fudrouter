<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDate, formatDateTime } from '$lib/format';
	import {
		Alert,
		Badge,
		Button,
		EmptyState,
		Guide,
		PageHeader,
		TableWrap
	} from '$lib/ui';
	import { formatMicro, type Micro } from '../billing-format';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	// $state declarations sit above the $deriveds that read through them, or
	// svelte-check reports "$state used before its declaration".
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	const currency = $derived(data.currency);
	const toneFor = (status: string): 'success' | 'warning' | 'neutral' =>
		status === 'paid' ? 'success' : status === 'open' ? 'warning' : 'neutral';
</script>
<PageHeader
	title="Invoices"
	lede="Monthly statements of billed usage. Payment processing is offline — an operator records payment by hand."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.generated}
	<div class="fr-feedback"><Alert tone="success">Invoice {form.number} generated.</Alert></div>
{/if}
{#if form?.already}
	<div class="fr-feedback">
		<Alert tone="info">An invoice for the previous period already exists ({form.number}).</Alert>
	</div>
{/if}
{#if form?.paid}
	<div class="fr-feedback"><Alert tone="success">Invoice {form.number} marked paid.</Alert></div>
{/if}
{#if form?.voided}
	<div class="fr-feedback"><Alert tone="success">Invoice {form.number} voided.</Alert></div>
{/if}
{#if data.canWrite}
	<form method="POST" action="?/generate" use:enhance={track}>
		<Button type="submit" variant="primary" {pending}>Generate invoice for last month</Button>
	</form>
	<p class="muted">
		Amounts the ledger's billed usage for the previous UTC calendar month. Generation is immediate
		computation in this request — scheduled runs arrive later with the invoice job worker.
	</p>
{/if}
<h2>Invoice history</h2>
<TableWrap label="Invoices">
	<table class="fr">
		<thead>
			<tr><th>Number</th><th>Period</th><th>Amount</th><th>Status</th><th>Issued</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.id)}
				<tr>
					<td class="num">{r.number}</td>
					<td class="num">{formatDate(new Date(r.periodStart))} → {formatDate(new Date(r.periodEnd))}</td>
					<td class="num">{formatMicro(r.amountMicro as Micro, r.currency)}</td>
					<td><Badge tone={toneFor(r.status)}>{r.status}</Badge></td>
					<td class="num">{r.issuedAt ? formatDateTime(new Date(r.issuedAt)) : '—'}</td>
					<td>
						{#if data.canWrite && (r.status === 'open' || r.status === 'draft')}
							<form method="POST" action="?/markPaid" use:enhance={track} class="inline">
								<input type="hidden" name="id" value={r.id} />
								<Button type="submit" {pending}>Mark paid</Button>
							</form>
							<form method="POST" action="?/void" use:enhance={track} class="inline">
								<input type="hidden" name="id" value={r.id} />
								<Button type="submit" {pending}>Void</Button>
							</form>
						{:else}
							—
						{/if}
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="6"
						><EmptyState
							title="No invoices yet"
							hint="Generate one above for the previous month."
						/></td
					></tr
				>
			{/each}
		</tbody>
	</table>
</TableWrap>
<nav class="billing-nav" aria-label="Billing sections">
	<a href="/dashboard/billing">Overview</a>
	<a href="/dashboard/billing/credits">Credits & ledger</a>
	<a href="/dashboard/billing/transactions">Transactions</a>
	<a href="/dashboard/billing/payment-methods">Payment methods</a>
</nav>
<Guide id="billing.invoices" />

<style>
	.inline {
		display: inline-block;
		margin-right: var(--space-xs);
	}
	.billing-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-top: var(--space-xl);
	}
</style>
