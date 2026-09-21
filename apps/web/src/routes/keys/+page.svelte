<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<h1>API Keys</h1>

{#if form?.created}
	<div class="created">
		<strong>Key created — copy it now, it is shown once.</strong>
		<code>{form.created}</code>
		<p>Use it as <code>Authorization: Bearer &lt;key&gt;</code> against the router.</p>
	</div>
{/if}
{#if form?.error}<p class="error">{form.error}</p>{/if}

<form method="POST" action="?/create" use:enhance>
	<input name="name" placeholder="key name" required />
	<button type="submit">Create key</button>
</form>

<table>
	<thead>
		<tr><th>Name</th><th>Prefix</th><th>Created</th><th>Status</th><th></th></tr>
	</thead>
	<tbody>
		{#each data.keys as k (k.id)}
			<tr>
				<td>{k.name}</td>
				<td><code>sk-ar-{k.prefix}…</code></td>
				<td>{k.createdAt.toISOString().slice(0, 10)}</td>
				<td>{k.revokedAt ? 'revoked' : 'active'}</td>
				<td>
					{#if !k.revokedAt}
						<form method="POST" action="?/revoke" use:enhance>
							<input type="hidden" name="id" value={k.id} />
							<button type="submit">Revoke</button>
						</form>
					{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="5">No keys yet.</td></tr>
		{/each}
	</tbody>
</table>

<style>
	.created {
		display: grid;
		gap: 0.5rem;
		padding: 1rem;
		border: 1px solid #2a7;
		border-radius: 6px;
		margin-bottom: 1rem;
	}
	.created code {
		word-break: break-all;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		margin-top: 1rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid #333;
	}
	form {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	td form {
		display: inline;
	}
	.error {
		color: #e66;
	}
</style>
