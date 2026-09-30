<script lang="ts">
	import { enhance } from '$app/forms';
	import { withPending } from '$lib/forms';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Guide,
		Input,
		PageHeader,
		Section,
		TableWrap,
		UxState
	} from '$lib/ui';
	let { data, form } = $props();
	let pending = $state(false);
	const uxState = $derived(
		data.denied ? 'denied' : data.queryError ? 'error' : data.chain.length ? 'success' : 'empty'
	);
	const levels = ['platform', 'workspace', 'project', 'environment', 'api_key'];
	const limitFields = [
		{ name: 'rpm', label: 'RPM' },
		{ name: 'tpm', label: 'TPM' },
		{ name: 'rpd', label: 'RPD' },
		{ name: 'tpd', label: 'TPD' },
		{ name: 'concurrency', label: 'Concurrency' },
		{ name: 'dailySpendMicro', label: 'Daily spend $' },
		{ name: 'monthlySpendMicro', label: 'Monthly spend $' }
	] as const;
	const spendField = (name: string): boolean => name.endsWith('SpendMicro');
	const fmtCell = (v: string | number | null | undefined): string =>
		v == null || v === '' ? 'inherit' : String(v);
</script>

<PageHeader
	title="Rate limits"
	lede={`The limit chain for ${data.projectName || 'this project'} — the smallest value across levels is what is enforced.`}
/>
<Guide id="limits" />

{#if form?.error}
	<Alert tone="danger">{form.error}</Alert>
{/if}
{#if form?.saved}
	<Alert tone="success">Limits saved.</Alert>
{/if}
{#if form?.removed}
	<Alert tone="success">Limit row removed — the scope inherits again.</Alert>
{/if}

<UxState
	state={uxState}
	emptyTitle="No limits configured"
	emptyHint="Nothing to resolve yet; add a scope row below to tighten a metric."
	errorWhat={data.queryError ?? undefined}
	errorWhy="Reading the limit chain failed on the server."
>
	<Section title="Effective limit chain" lede="Platform → workspace → project → environment → API key. Smallest wins.">
		<TableWrap label="Effective limit chain">
			<table class="fr">
				<thead>
					<tr>
						<th>Metric</th>
						<th>Platform</th><th>Workspace</th><th>Project</th><th>Environment</th><th>API key</th>
						<th>Effective</th><th>Binds at</th>
					</tr>
				</thead>
				<tbody>
					{#each data.chain as m (m.metric)}
						<tr>
							<td>{m.label}</td>
							{#each levels as lvl (lvl)}
								<td class="num">{fmtCell(m.byLevel[lvl])}</td>
							{/each}
							<td class="num">
								<Badge tone="info">{fmtCell(m.effective)}</Badge>
							</td>
							<td>{m.boundAtLabel ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
		<p class="muted">
			“inherit” means no limit at that level (not zero). Platform is read-only here — it is the
			platform hard limit. API key rows are read-only in the chain; edit a key’s policy on its own
			page.
		</p>
	</Section>

	<Section title="Edit a scope" lede="A blank field clears the limit back to inherit.">
		{#each data.editors as ed (ed.scopeId)}
			<form
				class="editor"
				method="POST"
				action="?/save"
				use:enhance={withPending((v) => (pending = v))}
			>
				<input type="hidden" name="scope" value={ed.scope} />
				<input type="hidden" name="scopeId" value={ed.scopeId} />
				<h3>{ed.label}</h3>
				<div class="fields">
					{#each limitFields as field (field.name)}
					<Field label={field.label}>
						<Input
							name={field.name}
							inputmode={spendField(field.name) ? 'decimal' : 'numeric'}
							value={ed.row ? ed.row.values[field.name] : ''}
							placeholder="inherit"
						/>
					</Field>
				{/each}
				</div>
				<div class="actions">
					<Button type="submit" variant="primary" {pending}>Save</Button>
					{#if ed.row}
						<Button
							type="submit"
							variant="danger"
							formaction="?/remove"
							{pending}
						>
							Clear
						</Button>
					{/if}
				</div>
			</form>
		{/each}
	</Section>

	<Section title="API key levels" lede="Read-only here — each key’s own policy page is where these are edited.">
		<TableWrap label="API key limits">
			<table class="fr">
				<thead>
					<tr><th>Key</th><th>RPM</th><th>TPM</th><th>RPD</th><th>TPD</th><th>Concurrency</th></tr>
				</thead>
				<tbody>
					{#each data.keyRows as k (k.id)}
						<tr>
							<td>{k.name}</td>
							<td class="num">{fmtCell(k.values.rpm)}</td>
							<td class="num">{fmtCell(k.values.tpm)}</td>
							<td class="num">{fmtCell(k.values.rpd)}</td>
							<td class="num">{fmtCell(k.values.tpd)}</td>
							<td class="num">{fmtCell(k.values.concurrency)}</td>
						</tr>
					{:else}
						<tr><td colspan="6">No API keys in this project.</td></tr>
					{/each}
				</tbody>
			</table>
		</TableWrap>
	</Section>
</UxState>

<style>
	.editor {
		display: grid;
		gap: var(--space-sm);
		padding: var(--space-md);
		margin-bottom: var(--space-md);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface);
	}
	.editor h3 {
		font-size: var(--text-sm);
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
	}
	.fields :global(.field) {
		width: 8.5rem;
	}
	.actions {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}
</style>
