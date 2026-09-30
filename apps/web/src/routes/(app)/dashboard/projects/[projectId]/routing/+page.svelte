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
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import DataTable from '$lib/components/DataTable.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import type { Column } from '$lib/table';
	import { policyToFormValues, SMART_INTENT, type PolicyFormValues } from '$lib/routing-form';
	import type { PageData } from './$types';
	type PolicyRow = PageData['policies'][number];
	let { data, form } = $props();
	// One flag for the page: any in-flight action disables every submit, which also
	// stops a double-click from firing two creates.
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	// ---- form state (create + edit share the shape; edit is seeded from the row) ----
	function blankValues(): PolicyFormValues {
		return {
			name: '',
			strategy: 'balanced',
			enabled: true,
			maxAttempts: '2',
			requestTimeoutMs: '30000',
			fallbackEnabled: true,
			providerOrder: [],
			modelOrder: [],
			constraints: {
				maxInputPriceMicro: '',
				maxOutputPriceMicro: '',
				maxP95LatencyMs: '',
				minAvailability: '',
				allowedProviders: '',
				blockedProviders: '',
				regionPreference: ''
			},
			weights: { price: '', latency: '', reliability: '', capacity: '' }
		};
	}
	let v = $state<PolicyFormValues>(blankValues());
	let editing = $state<PolicyRow | null>(null);
	let ev = $state<PolicyFormValues>(blankValues());
	let editScope = $state<'project' | 'workspace' | 'environment'>('project');
	let newScope = $state<'project' | 'workspace'>('project');
	let deleteTarget = $state<PolicyRow | null>(null);
	let confirmOpen = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
	const smartOption = $derived(
		data.strategies.find((s: PageData['strategies'][number]) => s.id === 'smart')
	);
	const intentOf = (strategy: string) =>
		data.strategies.find((s: PageData['strategies'][number]) => s.id === strategy)?.intent ??
		'';
	function handleSelect(setter: (value: string) => void) {
		return (e: Event) => {
			const select = e.currentTarget as HTMLSelectElement; // DOM event target is narrowed, not trusted data
			setter(select.value);
		};
	}
	function startEdit(row: PolicyRow): void {
		editing = row;
		ev = policyToFormValues(row);
		editScope = row.scope;
	}
	/** Order is preference (earlier wins), so moves are swaps. */
	function swap(list: string[], from: number, to: number): string[] {
		if (to < 0 || to >= list.length) return list;
		const out = [...list];
		[out[from], out[to]] = [out[to], out[from]];
		return out;
	}
	function addSlug(list: string[], slug: string): string[] {
		if (!slug || list.includes(slug)) return list;
		return [...list, slug];
	}
	// A successful update closes the editor; a failed one keeps it open with the
	// user's input so the error can be fixed and resubmitted.
	$effect(() => {
		if (form?.updated) editing = null;
	});
	const columns: Column<PolicyRow>[] = [
		{ key: 'name', label: 'Name', value: (r) => r.name, sortable: true },
		{ key: 'strategy', label: 'Strategy', value: (r) => r.strategy, sortable: true },
		{ key: 'enabled', label: 'Enabled', value: (r) => (r.enabled ? 'enabled' : 'disabled'), sortable: true },
		{ key: 'maxAttempts', label: 'Max attempts', value: (r) => r.maxAttempts, sortable: true, align: 'end' },
		{ key: 'timeout', label: 'Timeout', value: (r) => `${r.requestTimeoutMs} ms`, sortable: true, align: 'end' },
		{ key: 'fallback', label: 'Fallback', value: (r) => (r.fallbackEnabled ? 'on' : 'off'), sortable: true },
		{ key: 'scope', label: 'Scope', value: (r) => r.scope, sortable: true },
		{
			key: 'bound',
			label: 'Bound environments',
			value: (r) => r.boundEnvironments.join(', '),
			sortable: true
		}
	];
</script>
<PageHeader
	title="Routing policy"
	lede="How the router picks a provider for each request: strategy, retries, and the constraints a candidate must pass."
/>
<Guide id="routing" />
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Policy “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Policy “{form.updated}” saved.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Policy “{form.deleted}” deleted.</Alert></div>
{/if}
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
<Card>
	<h2>Create policy</h2>
	<form method="POST" action="?/create" use:enhance={track} class="stack">
		<Field label="Name" hint="Something you will recognise later, e.g. prod-balanced.">
			<Input name="name" bind:value={v.name} placeholder="prod-balanced" required />
		</Field>
		<Field label="Scope">
			<Select
				name="scope"
				value={newScope}
				onchange={handleSelect((raw) => (newScope = raw === 'workspace' ? 'workspace' : 'project'))}
			>
				<option value="project">project — only this project uses it</option>
				<option value="workspace">workspace — shared by every project in this workspace</option>
			</Select>
		</Field>
		<Field label="Strategy" hint={v.strategy === 'smart' ? SMART_INTENT : intentOf(v.strategy)}>
			<Select name="strategy" bind:value={v.strategy}>
				{#each data.strategies as s (s.id)}
					<option value={s.id} disabled={s.disabled}>{s.label}</option>
				{/each}
			</Select>
		</Field>
		{#if smartOption?.disabled}
			<p class="muted">{smartOption.intent}</p>
		{/if}
		<label class="check">
			<input type="checkbox" name="enabled" value="on" bind:checked={v.enabled} />
			Enabled
		</label>
		<Field label="Max attempts" hint="1–8 attempts per request (retries plus the first try).">
			<Input name="max_attempts" bind:value={v.maxAttempts} inputmode="numeric" required />
		</Field>
		<Field
			label="Request timeout (ms)"
			hint="1000–600000 ms. The router never starts an attempt that cannot finish inside it."
		>
			<Input name="request_timeout_ms" bind:value={v.requestTimeoutMs} inputmode="numeric" required />
		</Field>
		<label class="check">
			<input type="checkbox" name="fallback_enabled" value="on" bind:checked={v.fallbackEnabled} />
			Fallback enabled — try the next candidate when one fails
		</label>
		<!-- Ordered preference lists: earlier is preferred. Empty = no preference. -->
		<div class="stack">
			<span class="fr-label">Provider preference (earlier = preferred)</span>
			{#each v.providerOrder as slug, i (slug)}
				<div class="pref-row">
					<code>{slug}</code>
					<span class="fr-actions">
						<Button size="sm" onclick={() => (v.providerOrder = swap(v.providerOrder, i, i - 1))} {pending}>
							Move up
						</Button>
						<Button size="sm" onclick={() => (v.providerOrder = swap(v.providerOrder, i, i + 1))} {pending}>
							Move down
						</Button>
						<Button
							size="sm"
							variant="danger"
							onclick={() => (v.providerOrder = v.providerOrder.filter((s) => s !== slug))}
							{pending}
						>
							Remove
						</Button>
					</span>
				</div>
			{/each}
			<Field label="Add provider" hint="Order matters: the first entry is tried first.">
				<Select
					value=""
					onchange={handleSelect((slug) => (v.providerOrder = addSlug(v.providerOrder, slug)))}
				>
					<option value="">Choose a provider…</option>
					{#each data.providers as p (p.slug)}
						<option value={p.slug} disabled={p.slug != null && v.providerOrder.includes(p.slug)}>
							{p.slug} — {p.name}
						</option>
					{/each}
				</Select>
			</Field>
			<input type="hidden" name="provider_order" value={v.providerOrder.join('\n')} />
		</div>
		<div class="stack">
			<span class="fr-label">Model preference (earlier = preferred)</span>
			{#each v.modelOrder as slug, i (slug)}
				<div class="pref-row">
					<code>{slug}</code>
					<span class="fr-actions">
						<Button size="sm" onclick={() => (v.modelOrder = swap(v.modelOrder, i, i - 1))} {pending}>
							Move up
						</Button>
						<Button size="sm" onclick={() => (v.modelOrder = swap(v.modelOrder, i, i + 1))} {pending}>
							Move down
						</Button>
						<Button
							size="sm"
							variant="danger"
							onclick={() => (v.modelOrder = v.modelOrder.filter((s) => s !== slug))}
							{pending}
						>
							Remove
						</Button>
					</span>
				</div>
			{/each}
			<Field label="Add model" hint="Empty list = no model preference.">
				<Select value="" onchange={handleSelect((slug) => (v.modelOrder = addSlug(v.modelOrder, slug)))}>
					<option value="">Choose a model…</option>
					{#each data.models as m (m.slug)}
						<option value={m.slug} disabled={v.modelOrder.includes(m.slug)}>
							{m.slug} — {m.name}
						</option>
					{/each}
				</Select>
			</Field>
			<input type="hidden" name="model_order" value={v.modelOrder.join('\n')} />
		</div>
		<!-- Constraints: empty = no claim on the router (missing ≠ zero). -->
		<div class="stack">
			<span class="fr-label">Constraints (empty = unconstrained)</span>
			<Field label="Max input price" hint="USD per 1M input tokens, e.g. 2.50. Money never touches a float.">
				<Input name="max_input_price_micro" bind:value={v.constraints.maxInputPriceMicro} placeholder="2.50" />
			</Field>
			<Field label="Max output price" hint="USD per 1M output tokens.">
				<Input name="max_output_price_micro" bind:value={v.constraints.maxOutputPriceMicro} placeholder="10" />
			</Field>
			<Field label="Max p95 latency (ms)">
				<Input name="max_p95_latency_ms" bind:value={v.constraints.maxP95LatencyMs} inputmode="numeric" />
			</Field>
			<Field label="Min availability" hint="Fraction 0–1, e.g. 0.99 for 99%.">
				<Input name="min_availability" bind:value={v.constraints.minAvailability} placeholder="0.99" />
			</Field>
			<Field label="Allowed providers" hint="Provider slugs, one per line. Empty = any provider.">
				<Textarea name="allowed_providers" rows="2" bind:value={v.constraints.allowedProviders}></Textarea>
			</Field>
			<Field label="Blocked providers" hint="Provider slugs, one per line.">
				<Textarea name="blocked_providers" rows="2" bind:value={v.constraints.blockedProviders}></Textarea>
			</Field>
			<Field label="Region preference" hint="Exact-match on the connection region, e.g. eu-west-1.">
				<Input name="region_preference" bind:value={v.constraints.regionPreference} />
			</Field>
		</div>
		{#if v.strategy === 'balanced'}
			<div class="stack">
				<span class="fr-label">Balanced weights (0–100 each; empty = default)</span>
				<div class="weight-grid">
					<Field label="Price"><Input name="weight_price" bind:value={v.weights.price} inputmode="numeric" /></Field>
					<Field label="Latency"><Input name="weight_latency" bind:value={v.weights.latency} inputmode="numeric" /></Field>
					<Field label="Reliability"><Input name="weight_reliability" bind:value={v.weights.reliability} inputmode="numeric" /></Field>
					<Field label="Capacity"><Input name="weight_capacity" bind:value={v.weights.capacity} inputmode="numeric" /></Field>
				</div>
			</div>
		{:else}
			<!-- Weights only score the balanced strategy, but they round-trip: a
			     switch to balanced must not silently drop what was stored. -->
			<input type="hidden" name="weight_price" value={v.weights.price} />
			<input type="hidden" name="weight_latency" value={v.weights.latency} />
			<input type="hidden" name="weight_reliability" value={v.weights.reliability} />
			<input type="hidden" name="weight_capacity" value={v.weights.capacity} />
		{/if}
		<Button type="submit" variant="primary" {pending}>Create policy</Button>
	</form>
</Card>
{#if editing}
	<Card>
		<h2>Edit policy: {editing.name}</h2>
		<form method="POST" action="?/update" use:enhance={track} class="stack">
			<input type="hidden" name="id" value={editing.id} />
			<Field label="Name">
				<Input name="name" bind:value={ev.name} required />
			</Field>
			<Field label="Scope">
				<Select
					name="scope"
					value={editScope}
					onchange={handleSelect((raw) =>
						(editScope = raw === 'workspace' ? 'workspace' : raw === 'environment' ? 'environment' : 'project')
					)}
				>
					<option value="project">project — only this project uses it</option>
					<option value="workspace">workspace — shared by every project in this workspace</option>
					<option value="environment" disabled={editing.scope !== 'environment'}>
						environment — bound to a single environment
					</option>
				</Select>
			</Field>
			<Field label="Strategy" hint={ev.strategy === 'smart' ? SMART_INTENT : intentOf(ev.strategy)}>
				<Select name="strategy" bind:value={ev.strategy}>
					{#each data.strategies as s (s.id)}
						<option value={s.id} disabled={s.disabled}>{s.label}</option>
					{/each}
				</Select>
			</Field>
			<label class="check">
				<input type="checkbox" name="enabled" value="on" bind:checked={ev.enabled} />
				Enabled
			</label>
			<Field label="Max attempts" hint="1–8 attempts per request.">
				<Input name="max_attempts" bind:value={ev.maxAttempts} inputmode="numeric" required />
			</Field>
			<Field label="Request timeout (ms)" hint="1000–600000 ms.">
				<Input name="request_timeout_ms" bind:value={ev.requestTimeoutMs} inputmode="numeric" required />
			</Field>
			<label class="check">
				<input type="checkbox" name="fallback_enabled" value="on" bind:checked={ev.fallbackEnabled} />
				Fallback enabled
			</label>
			<div class="stack">
				<span class="fr-label">Provider preference (earlier = preferred)</span>
				{#each ev.providerOrder as slug, i (slug)}
					<div class="pref-row">
						<code>{slug}</code>
						<span class="fr-actions">
							<Button size="sm" onclick={() => (ev.providerOrder = swap(ev.providerOrder, i, i - 1))} {pending}>
								Move up
							</Button>
							<Button size="sm" onclick={() => (ev.providerOrder = swap(ev.providerOrder, i, i + 1))} {pending}>
								Move down
							</Button>
							<Button
								size="sm"
								variant="danger"
								onclick={() => (ev.providerOrder = ev.providerOrder.filter((s) => s !== slug))}
								{pending}
							>
								Remove
							</Button>
						</span>
					</div>
				{/each}
				<Field label="Add provider">
					<Select
						value=""
						onchange={handleSelect((slug) => (ev.providerOrder = addSlug(ev.providerOrder, slug)))}
					>
						<option value="">Choose a provider…</option>
						{#each data.providers as p (p.slug)}
							<option value={p.slug} disabled={p.slug != null && ev.providerOrder.includes(p.slug)}>
								{p.slug} — {p.name}
							</option>
						{/each}
					</Select>
				</Field>
				<input type="hidden" name="provider_order" value={ev.providerOrder.join('\n')} />
			</div>
			<div class="stack">
				<span class="fr-label">Model preference (earlier = preferred)</span>
				{#each ev.modelOrder as slug, i (slug)}
					<div class="pref-row">
						<code>{slug}</code>
						<span class="fr-actions">
							<Button size="sm" onclick={() => (ev.modelOrder = swap(ev.modelOrder, i, i - 1))} {pending}>
								Move up
							</Button>
							<Button size="sm" onclick={() => (ev.modelOrder = swap(ev.modelOrder, i, i + 1))} {pending}>
								Move down
							</Button>
							<Button
								size="sm"
								variant="danger"
								onclick={() => (ev.modelOrder = ev.modelOrder.filter((s) => s !== slug))}
								{pending}
							>
								Remove
							</Button>
						</span>
					</div>
				{/each}
				<Field label="Add model">
					<Select
						value=""
						onchange={handleSelect((slug) => (ev.modelOrder = addSlug(ev.modelOrder, slug)))}
					>
						<option value="">Choose a model…</option>
						{#each data.models as m (m.slug)}
							<option value={m.slug} disabled={ev.modelOrder.includes(m.slug)}>
								{m.slug} — {m.name}
							</option>
						{/each}
					</Select>
				</Field>
				<input type="hidden" name="model_order" value={ev.modelOrder.join('\n')} />
			</div>
			<div class="stack">
				<span class="fr-label">Constraints (empty = unconstrained)</span>
				<Field label="Max input price" hint="USD per 1M input tokens.">
					<Input name="max_input_price_micro" bind:value={ev.constraints.maxInputPriceMicro} />
				</Field>
				<Field label="Max output price" hint="USD per 1M output tokens.">
					<Input name="max_output_price_micro" bind:value={ev.constraints.maxOutputPriceMicro} />
				</Field>
				<Field label="Max p95 latency (ms)">
					<Input name="max_p95_latency_ms" bind:value={ev.constraints.maxP95LatencyMs} inputmode="numeric" />
				</Field>
				<Field label="Min availability" hint="Fraction 0–1, e.g. 0.99 for 99%.">
					<Input name="min_availability" bind:value={ev.constraints.minAvailability} />
				</Field>
				<Field label="Allowed providers" hint="Provider slugs, one per line.">
					<Textarea name="allowed_providers" rows="2" bind:value={ev.constraints.allowedProviders}></Textarea>
				</Field>
				<Field label="Blocked providers" hint="Provider slugs, one per line.">
					<Textarea name="blocked_providers" rows="2" bind:value={ev.constraints.blockedProviders}></Textarea>
				</Field>
				<Field label="Region preference" hint="Exact-match on the connection region.">
					<Input name="region_preference" bind:value={ev.constraints.regionPreference} />
				</Field>
			</div>
			{#if ev.strategy === 'balanced'}
				<div class="stack">
					<span class="fr-label">Balanced weights (0–100 each; empty = default)</span>
					<div class="weight-grid">
						<Field label="Price"><Input name="weight_price" bind:value={ev.weights.price} inputmode="numeric" /></Field>
						<Field label="Latency"><Input name="weight_latency" bind:value={ev.weights.latency} inputmode="numeric" /></Field>
						<Field label="Reliability"><Input name="weight_reliability" bind:value={ev.weights.reliability} inputmode="numeric" /></Field>
						<Field label="Capacity"><Input name="weight_capacity" bind:value={ev.weights.capacity} inputmode="numeric" /></Field>
					</div>
				</div>
			{:else}
				<input type="hidden" name="weight_price" value={ev.weights.price} />
				<input type="hidden" name="weight_latency" value={ev.weights.latency} />
				<input type="hidden" name="weight_reliability" value={ev.weights.reliability} />
				<input type="hidden" name="weight_capacity" value={ev.weights.capacity} />
			{/if}
			<span class="fr-actions">
				<Button type="submit" variant="primary" {pending}>Save policy</Button>
				<Button onclick={() => (editing = null)} {pending}>Cancel</Button>
			</span>
		</form>
	</Card>
{/if}
<DataTable
	caption="Routing policies"
	rows={data.policies}
	{columns}
	keyOf={(row) => row.id}
	filters={[
		{
			key: 'scope',
			label: 'Scope',
			options: [
				{ value: 'project', label: 'Project' },
				{ value: 'workspace', label: 'Workspace' },
				{ value: 'environment', label: 'Environment' }
			]
		},
		{
			key: 'enabled',
			label: 'Enabled',
			options: [
				{ value: 'enabled', label: 'Enabled' },
				{ value: 'disabled', label: 'Disabled' }
			]
		}
	]}
	empty={{ title: 'No routing policies yet', hint: 'Create one above to control how requests are routed.' }}
>
	{#snippet rowActions(row: PolicyRow)}
		<span class="fr-actions">
			<Badge tone={row.scope === 'workspace' ? 'info' : row.scope === 'environment' ? 'warning' : 'success'}>
				{row.scope}
			</Badge>
			{#each row.boundEnvironments as env (env)}
				<Badge tone="neutral">bound: {env}</Badge>
			{/each}
			<Button size="sm" onclick={() => startEdit(row)} {pending}>Edit</Button>
			<Button
				size="sm"
				variant="danger"
				onclick={() => {
					deleteTarget = row;
					confirmOpen = true;
				}}
				{pending}
			>
				Delete
			</Button>
		</span>
	{/snippet}
</DataTable>
<!-- The binding display is read-only on purpose: environment.routing_policy_id
     is edited on the environments page — one writer per fact. -->
<Card>
	<h2>Environment bindings</h2>
	{#if data.bindings.length === 0}
		<p class="muted">No environments in this project yet.</p>
	{:else}
		<ul class="binding-list">
			{#each data.bindings as b (b.environmentId)}
				<li>
					<strong>{b.environmentName}</strong>
					{#if b.policyName}
						→ <code>{b.policyName}</code>
					{:else}
						<Badge tone="neutral">not bound</Badge>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="muted">
			Bindings are read-only here — the link is edited on the environments page.
		</p>
	{/if}
</Card>
<form method="POST" action="?/delete" use:enhance={track} bind:this={deleteForm} class="sr-only">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
	<Button type="submit" {pending}>Delete policy</Button>
</form>
<ConfirmDialog
	bind:open={confirmOpen}
	title="Delete routing policy?"
	body={deleteTarget
		? `“${deleteTarget.name}” stops routing requests; environments bound to it fall back to the default policy.`
		: ''}
	typed={deleteTarget?.name ?? null}
	danger
	confirmLabel="Delete policy"
	onconfirm={() => deleteForm?.requestSubmit()}
	oncancel={() => (deleteTarget = null)}
/>
<style>
	.pref-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: center;
		justify-content: space-between;
		padding: var(--space-xs) 0;
		border-bottom: 1px solid var(--color-border);
	}
	.check {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
	}
	.weight-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--space-sm);
	}
	.binding-list {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
</style>
