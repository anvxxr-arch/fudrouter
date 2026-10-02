<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let models = $state([])
  let showForm = $state(false)
  let form = $state({ id: '', provider: 'custom', name: '', baseUrl: '', apiKey: '', inputPrice: 0, outputPrice: 0 })
  let loading = $state(true)
  
  onMount(async () => {
    try {
      const res = await fetch('/api/models/custom')
      if (res.ok) {
        const data = await res.json()
        models = data.customModels || []
      }
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  async function save() {
    try {
      const res = await fetch('/api/models/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      })
      if (res.ok) {
        showForm = false
        form = { id: '', provider: 'custom', name: '', baseUrl: '', apiKey: '', inputPrice: 0, outputPrice: 0 }
        const data = await (await fetch('/api/models/custom')).json()
        models = data.customModels || []
      }
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  async function deleteModel(id) {
    if (!confirm('Remove this custom model?')) return
    try {
      await fetch('/api/models/custom', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      models = models.filter(m => m.id !== id)
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }
  
  function fmtPrice(p) {
    if (!p) return '-'
    return '$' + Number(p).toFixed(6)
  }
</script>

<h1>Custom Models</h1>

<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem">
  <p class="muted">{models.length} models</p>
  <button class="btn btn-primary" onclick={() => showForm = !showForm}>
    {showForm ? 'Cancel' : '+ Add Model'}
  </button>
</div>

{#if showForm}
<div class="card" style="margin-bottom:1rem">
  <h2>New Custom Model</h2>
  <div class="form-grid">
    <input class="input" placeholder="Model ID (e.g. my-model)" bind:value={form.id} />
    <input class="input" placeholder="Display name" bind:value={form.name} />
    <input class="input" placeholder="Base URL" bind:value={form.baseUrl} />
    <input class="input" type="password" placeholder="API Key" bind:value={form.apiKey} />
    <input class="input" type="number" placeholder="Input price (per 1M tokens)" bind:value={form.inputPrice} />
    <input class="input" type="number" placeholder="Output price (per 1M tokens)" bind:value={form.outputPrice} />
  </div>
  <button class="btn btn-primary" onclick={save} style="margin-top:1rem">Save</button>
</div>
{/if}

{#if loading}
  <p class="muted">Loading...</p>
{:else if models.length > 0}
  <div class="card">
    <table class="table">
      <thead><tr><th>ID</th><th>Provider</th><th>Name</th><th>Input</th><th>Output</th><th></th></tr></thead>
      <tbody>
        {#each models as m}
          <tr>
            <td>{m.id}</td>
            <td>{m.provider || 'custom'}</td>
            <td>{m.name || '-'}</td>
            <td>{fmtPrice(m.inputPrice)}</td>
            <td>{fmtPrice(m.outputPrice)}</td>
            <td><button class="btn btn-ghost" style="padding:.2rem .5rem" onclick={() => deleteModel(m.id)}>🗑</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">
    <p class="muted">No custom models yet</p>
  </div>
{/if}

<style>
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin-top: .8rem; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 3rem; }
</style>
