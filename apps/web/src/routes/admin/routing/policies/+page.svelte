<script lang="ts">
	import { enhance } from '$app/forms';
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
		TableWrap,
		Textarea
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	let { data, form } = $props();
	let pending = $state(false);
	const track = withPending((v) => (pending = v));
	let editing = $state<string | null>(null);
	function toggle(id: string) {
		editing = editing === id ? null : id;
	}
	function scopeOf(p: { workspaceId: string | null; projectId: string | null; environmentId: string | null }): string {
		return p.environmentId ? 'environment' : p.projectId ? 'project' : p.workspaceId ? 'workspace' : 'platform';
	}
	function scopeIdOf(p: { workspaceId: string | null; projectId: string | null; environmentId: string | null }): string {
		return p.environmentId ?? p.projectId ?? p.workspaceId ?? '';
	}
	function pretty(v: Record<string, unknown>): string {
		return JSON.stringify(v ?? {});
	}
</script>
<PageHeader
	title="Routing policies"
	lede="Strategy, retry and scope per policy. A policy is platform-scope when all three scope columns are empty."
/>
{#if form?.error}<div class="fr-feedback"><Alert tone="danger">{form.error}</Alert></div>{/if}
{#if form?.created}
	<div class="fr-feedback"><Alert tone="success">Policy “{form.created}” created.</Alert></div>
{/if}
{#if form?.updated}
	<div class="fr-feedback"><Alert tone="success">Policy updated.</Alert></div>
{/if}
{#if form?.deleted}
	<div class="fr-feedback"><Alert tone="success">Policy deleted.</Alert></div>
{/if}
<Card>
	<h2 class="first">Add policy</h2>
	<form method="POST" action="?/create" use:enhance={track}>
		<div class="fr-grid">
			<Field label="Name"><Input name="name" placeholder="prod-balanced" required /></Field>
			<Field label="Strategy">
				<Select name="strategy">
					{#each data.strategies as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Max attempts"><Input name="maxAttempts" type="number" value="2" /></Field>
			<Field label="Request timeout (ms)"
				><Input name="requestTimeoutMs" type="number" value="30000" /></Field
			>
			<Field label="Scope">
				<Select name="scope">
					{#each data.scopes as s (s)}<option value={s}>{s}</option>{/each}
				</Select>
			</Field>
			<Field label="Scope target" hint="Workspace / project / environment id; leave blank for platform.">
				<Select name="scopeId">
					<option value="">— none (platform) —</option>
					{#each data.workspaces as w (w.id)}<option value={w.id}>workspace: {w.name}</option>{/each}
					{#each data.projects as p (p.id)}<option value={p.id}>project: {p.name}</option>{/each}
					{#each data.environments as e (e.id)}
						<option value={e.id}>environment: {e.name}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Enabled"><Input name="enabled" type="checkbox" checked /></Field>
			<Field label="Fallback enabled"><Input name="fallbackEnabled" type="checkbox" checked /></Field>
		</div>
		<div class="fr-grid">
			<Field label="provider_preferences" hint="JSON object."><Textarea name="providerPreferences" rows="2" placeholder={'{}'}></Textarea></Field>
			<Field label="model_preferences" hint="JSON object."><Textarea name="modelPreferences" rows="2" placeholder={'{}'}></Textarea></Field>
			<Field label="constraints" hint="JSON object."><Textarea name="constraints" rows="2" placeholder={'{}'}></Textarea></Field>
			<Field label="weights" hint={'JSON object, e.g. {"price": 0.4}.'}><Textarea name="weights" rows="2" placeholder={'{}'}></Textarea></Field>
		</div>
		<div class="submit">
			<Button type="submit" {pending} variant="primary">Create policy</Button>
		</div>
	</form>
</Card>
<Guide id="admin-routing-policies" />
<TableWrap label="Routing policies">
	<table class="fr">
		<thead>
			<tr
				><th>Name</th><th>Scope</th><th>Strategy</th><th>Attempts</th><th>Timeout</th><th
					>Weights</th
				><th>Actions</th></tr
			>
		</thead>
		<tbody>
			{#each data.policies as p (p.id)}
				<tr>
					<td>{p.name}</td>
					<td><Badge tone={scopeOf(p) === 'platform' ? 'info' : 'neutral'}>{scopeOf(p)}</Badge></td>
					<td><code>{p.strategy}</code></td>
					<td class="num">{p.maxAttempts}</td>
					<td class="num">{p.requestTimeoutMs.toLocaleString()} ms</td>
					<td><code class="weights">{pretty(p.weights)}</code></td>
					<td class="fr-actions">
						<Button type="button" onclick={() => toggle(p.id)}>Edit</Button>
						<form method="POST" action="?/delete" use:enhance={track} class="fr-inline">
							<input type="hidden" name="id" value={p.id} />
							<Button type="submit" {pending} variant="danger" aria-label="Delete policy {p.name}">
								Delete
							</Button>
						</form>
					</td>
				</tr>
				{#if editing === p.id}
					<tr class="edit-row">
						<td colspan="7">
							<form method="POST" action="?/update" use:enhance={track}>
								<input type="hidden" name="id" value={p.id} />
								<div class="fr-grid">
									<Field label="Name"><Input name="name" value={p.name} /></Field>
									<Field label="Strategy">
										<Select name="strategy">
											{#each data.strategies as s (s)}
												<option value={s} selected={s === p.strategy}>{s}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Max attempts"
										><Input name="maxAttempts" type="number" value={p.maxAttempts} /></Field
									>
									<Field label="Request timeout (ms)"
										><Input name="requestTimeoutMs" type="number" value={p.requestTimeoutMs} /></Field
									>
									<Field label="Scope">
										<Select name="scope">
											{#each data.scopes as s (s)}
												<option value={s} selected={s === scopeOf(p)}>{s}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Scope target">
										<Select name="scopeId">
											<option value="" selected={scopeIdOf(p) === ''}>— none (platform) —</option>
											{#each data.workspaces as w (w.id)}
												<option value={w.id} selected={w.id === scopeIdOf(p)}>workspace: {w.name}</option>
											{/each}
											{#each data.projects as pr (pr.id)}
												<option value={pr.id} selected={pr.id === scopeIdOf(p)}>project: {pr.name}</option>
											{/each}
											{#each data.environments as e (e.id)}
												<option value={e.id} selected={e.id === scopeIdOf(p)}>environment: {e.name}</option>
											{/each}
										</Select>
									</Field>
									<Field label="Enabled"
										><Input name="enabled" type="checkbox" checked={p.enabled} /></Field
									>
									<Field label="Fallback enabled"
										><Input name="fallbackEnabled" type="checkbox" checked={p.fallbackEnabled} /></Field
									>
								</div>
								<div class="fr-grid">
									<Field label="provider_preferences"
										><Textarea name="providerPreferences" rows="2" value={pretty(p.providerPreferences)}
										></Textarea></Field
									>
									<Field label="model_preferences"
										><Textarea name="modelPreferences" rows="2" value={pretty(p.modelPreferences)}
										></Textarea></Field
									>
									<Field label="constraints"
										><Textarea name="constraints" rows="2" value={pretty(p.constraints)}></Textarea></Field
									>
									<Field label="weights"
										><Textarea name="weights" rows="2" value={pretty(p.weights)}></Textarea></Field
									>
								</div>
								<div class="submit">
									<Button type="submit" {pending} variant="primary" aria-label="Save policy {p.name}">
										Save
									</Button>
								</div>
							</form>
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td colspan="7"><EmptyState title="No routing policies yet" /></td></tr>
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
	.weights {
		font-size: var(--text-sm);
	}
</style>
