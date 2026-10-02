<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let connections = $state([])
  let showForm = $state(false)
  let editing = $state(null)
  let form = $state({ name: '', provider: 'anthropic', baseUrl: '', apiKey: '', isActive: true })
  let loading = $state(true)
  
  const providers = ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'xai', 'qwen', 'zhipu', 'moonshot']
  
  onMount(async () => {
    await load()
  })
  
  async function load() {
    try {
      connections = await api.getConnections()
    } catch (e) {
      console.error('Failed:', e)
    }
    loading = false
  }
  
  function startEdit(c) {
    editing = c.id
    form = { name: c.name, provider: c.provider, baseUrl: c.baseUrl || '', apiKey: '', isActive: c.isActive }
    showForm = true
  }
  
  function startNew() {
    editing = null
    form = { name: '', provider: 'anthropic', baseUrl: '', apiKey: '', isActive: true }
    showForm = true
  }
  
  async function save() {
    try {
      if (editing) {
        await api.updateConnection(editing, form)
      } else {
        await api.createConnection(form)
      }
      await load()
      showForm = false
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  async function testConnection(id) {
    try {
      await api.testConnection(id)
      alert('Connection test passed!')
    } catch (e) {
      alert('Test failed: ' + e.message)
    }
  }
  
  async function deleteConn(id) {
    if (!confirm('Delete this connection?')) return
    try {
      await api.deleteConnection(id)
      await load()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
</script>

<h1>Connections</h1>

<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem">
  <p class="muted">{connections.length} total · {connections.filter(c => c.isActive).length} active</p>
  <button class="btn btn-primary" onclick={startNew}>+ Add Connection</button>
</div>

{#if showForm}
<div class="card" style="margin-bottom:1rem">
  <h2>{editing ? 'Edit' : 'New'} Connection</h2>
  <div class="form-grid">
    <label>
      <span class="field-label">Name</span>
      <input class="input" placeholder="e.g. Claude Sonnet" bind:value={form.name} />
    </label>
    <label>
      <span class="field-label">Provider</span>
      <select class="input" bind:value={form.provider}>
        {#each providers as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </label>
    <label>
      <span class="field-label">Base URL</span>
      <input class="input" placeholder="https://api.anthropic.com/v1" bind:value={form.baseUrl} />
    </label>
    <label>
      <span class="field-label">API Key {editing ? '(leave blank to keep)' : ''}</span>
      <input class="input" type="password" placeholder="sk-..." bind:value={form.apiKey} />
    </label>
    <label class="checkbox-label">
      <input type="checkbox" bind:checked={form.isActive} />
      <span>Active</span>
    </label>
  </div>
  <div style="display:flex; gap:.5rem; margin-top:1rem">
    <button class="btn btn-primary" onclick={save}>{editing ? 'Update' : 'Create'}</button>
    <button class="btn btn-ghost" onclick={() => showForm = false}>Cancel</button>
  </div>
</div>
{/if}

{#if loading}
  <p class="muted">Loading...</p>
{:else if connections.length > 0}
  <div class="card">
    <table class="table">
      <thead>
        <tr><th>Name</th><th>Provider</th><th>Base URL</th><th>Status</th><th>Priority</th><th></th></tr>
      </thead>
      <tbody>
        {#each connections as c}
          <tr>
            <td>{c.name}</td>
            <td>{c.provider}</td>
            <td class="muted url-cell">{c.baseUrl}</td>
            <td>
              <span class="badge" class:badge-active={c.isActive} class:badge-error={!c.isActive}>
                {c.isActive ? 'active' : 'off'}
              </span>
            </td>
            <td>{c.priority}</td>
            <td class="actions">
              <button class="btn btn-ghost" onclick={() => testConnection(c.id)} title="Test">🔌</button>
              <button class="btn btn-ghost" onclick={() => startEdit(c)} title="Edit">✏️</button>
              <button class="btn btn-ghost" onclick={() => deleteConn(c.id)} title="Delete">🗑</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">
    <p class="muted">No connections yet</p>
    <button class="btn btn-primary" onclick={startNew}>Add your first connection</button>
  </div>
{/if}

<style>
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin-top: .8rem; }
  .field-label { display: block; font-size: .75rem; color: var(--text-muted); margin-bottom: .2rem; text-transform: uppercase; }
  .checkbox-label { display: flex; align-items: center; gap: .5rem; }
  .url-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; }
  .actions { display: flex; gap: .3rem; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 3rem; }
</style>
