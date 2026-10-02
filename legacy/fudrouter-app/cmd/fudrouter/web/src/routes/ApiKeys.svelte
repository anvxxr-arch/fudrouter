<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let keys = $state([])
  let showForm = $state(false)
  let form = $state({ name: '', key: '' })
  let loading = $state(true)
  
  onMount(async () => {
    await load()
  })
  
  async function load() {
    try {
      keys = await api.getKeys()
    } catch (e) {
      console.error('Failed to load keys:', e)
    }
    loading = false
  }
  
  async function save() {
    try {
      await api.createKey(form)
      await load()
      showForm = false
      form = { name: '', key: '' }
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  async function deleteKey(id) {
    if (!confirm('Delete this API key?')) return
    try {
      await api.deleteKey(id)
      await load()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  function maskKey(k) {
    if (!k) return ''
    return k.substring(0, 8) + '...' + k.substring(k.length - 4)
  }
</script>

<h1>API Keys</h1>

<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem">
  <p class="muted">{keys.length} keys</p>
  <button class="btn btn-primary" onclick={() => showForm = !showForm}>
    {showForm ? 'Cancel' : '+ Add Key'}
  </button>
</div>

{#if showForm}
<div class="card" style="margin-bottom:1rem">
  <h2>New API Key</h2>
  <div style="display: grid; gap: .8rem; margin-top: .8rem">
    <input class="input" placeholder="Name (e.g. Production)" bind:value={form.name} />
    <input class="input" placeholder="API key (will be stored encrypted)" bind:value={form.key} />
    <button class="btn btn-primary" onclick={save}>Save Key</button>
  </div>
</div>
{/if}

{#if loading}
  <p class="muted">Loading...</p>
{:else if keys.length > 0}
  <div class="card">
    <table class="table">
      <thead><tr><th>Name</th><th>Key</th><th>Machine</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {#each keys as k}
          <tr>
            <td>{k.name}</td>
            <td><code>{maskKey(k.key)}</code></td>
            <td class="muted">{k.machineId || '-'}</td>
            <td><span class="badge badge-active">{k.isActive ? 'Active' : 'Revoked'}</span></td>
            <td><button class="btn btn-ghost" style="padding:.2rem .5rem" onclick={() => deleteKey(k.id)}>🗑</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">
    <p class="muted">No API keys yet</p>
    <button class="btn btn-primary" onclick={() => showForm = true}>Add your first key</button>
  </div>
{/if}

<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 3rem; }
  code { background: rgba(255,255,255,0.05); padding: .2rem .5rem; border-radius: 4px; font-size: .8rem; }
</style>
