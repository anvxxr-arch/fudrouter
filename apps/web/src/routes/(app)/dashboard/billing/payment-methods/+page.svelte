<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Alert,
		Button,
		Card,
		EmptyState,
		Field,
		Guide,
		Input,
		PageHeader,
		Select,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
</script>
<PageHeader
	title="Payment methods"
	lede="How this workspace intends to pay. Nothing is on file and nothing is charged here."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.recorded}
	<div class="fr-feedback">
		<Alert tone="success">Intent recorded. An operator will follow up to set up billing.</Alert>
	</div>
{/if}
<!-- The honest state: there is no payment method, so the empty state leads and
     the form below is explicitly intent — not a payment form that could be
     mistaken for one (no card fields, no fake "save card"). -->
<EmptyState
	title="No payment method on file"
	hint="This deployment does not process payments. Record your intent below and an operator sets up billing offline."
/>
<div class="narrow">
	<Card>
		{#if data.intent}
			<h2>Recorded intent</h2>
			<p>
				Method: <strong>{data.intent.method}</strong> · Contact: <strong>{data.intent.contact}</strong>
				{#if data.intent.note}<br />Note: {data.intent.note}{/if}
			</p>
			<p class="muted">Recorded {data.intent.recordedAt}. Submit again to replace it.</p>
		{/if}
		{#if data.canWrite}
			<form method="POST" action="?/record" use:enhance={track} class="stack">
				<Field label="Intended method" hint="Nothing is charged — this only tells us how you want to pay.">
					<Select name="method" required>
						<option value="">Choose…</option>
						<option value="invoice / bank transfer">Invoice / bank transfer</option>
						<option value="card">Card (set up offline)</option>
						<option value="prepaid credits">Prepaid credits</option>
						<option value="other">Other — see note</option>
					</Select>
				</Field>
				<Field label="Billing contact" hint="Email or name an operator should reach.">
					<Input name="contact" placeholder="billing@example.com" required />
				</Field>
				<Field label="Note" hint="Anything an operator should know.">
					<Textarea name="note" rows="3"></Textarea>
				</Field>
				<Button type="submit" variant="primary" {pending}>Record intent</Button>
			</form>
		{:else}
			<p class="muted">You need <code>billing.write</code> to record billing intent.</p>
		{/if}
	</Card>
</div>
<nav class="billing-nav" aria-label="Billing sections">
	<a href="/dashboard/billing">Overview</a>
	<a href="/dashboard/billing/credits">Credits & ledger</a>
	<a href="/dashboard/billing/transactions">Transactions</a>
	<a href="/dashboard/billing/invoices">Invoices</a>
</nav>
<Guide id="billing.paymentMethods" />

<style>
	.stack {
		display: grid;
		gap: var(--space-md);
		justify-items: start;
	}
	.billing-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-top: var(--space-xl);
	}
</style>
