<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let status = $state(null)
  let loading = $state(false)
  let updating = $state(false)
  
  onMount(async () => {
    try {
      status = await api.getUpdateStatus()
    } catch (e) {
      console.error(e)
    }
  })
  
  async function checkUpdate() {
    loading = true
    try {
      status = await api.getUpdateStatus()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
    loading = false
  }
  
  async function doUpdate() {
    if (!confirm('Update and restart fudrouter? Brief downtime expected.')) return
    updating = true
    try {
      await api.startUpdate()
      // Poll for completion
      const interval = setInterval(async () => {
        try {
          status = await api.getUpdateStatus()
          if (status.complete || status.error) {
            clearInterval(interval)
            updating = false
          }
        } catch {
          clearInterval(interval)
          updating = false
        }
      }, 2000)
    } catch (e) {
      alert('Failed: ' + e.message)
      updating = false
    }
  }
</script>

<h1>Update</h1>

<div class="card" style="max-width: 600px">
  <h2>Current Version</h2>
  {#if status}
    <div style="display:flex; justify-content:space-between; margin-top:.8rem">
      <div>
        <div class="stat-value" style="font-size:1.2rem">{status.version || '1.0.0-go'}</div>
        <div class="stat-label">{status.runtime || 'go'}</div>
      </div>
      <div>
        <div class="stat-value" style="font-size:1.2rem">{status.commit?.substring(0, 8) || '—'}</div>
        <div class="stat-label">commit</div>
      </div>
      <div>
        <div class="stat-value" style="font-size:1.2rem">{status.buildDate || '—'}</div>
        <div class="stat-label">built</div>
      </div>
    </div>
  {:else}
    <p class="muted">Loading version info...</p>
  {/if}
  
  <div style="display:flex; gap:.5rem; margin-top:1.5rem">
    <button class="btn btn-ghost" onclick={checkUpdate} disabled={loading}>
      {loading ? 'Checking...' : '↻ Check for Updates'}
    </button>
    <button class="btn btn-primary" onclick={doUpdate} disabled={updating}>
      {updating ? 'Updating...' : '⚡ Update & Restart'}
    </button>
  </div>
  
  {#if updating}
    <div style="margin-top:1rem">
      <p class="muted">Update in progress... This page will refresh when complete.</p>
    </div>
  {/if}
</div>

{#if status?.changelog}
<div class="card" style="max-width: 600px; margin-top:1rem">
  <h2>Changelog</h2>
  <pre style="margin-top:.8rem; font-size:.8rem; white-space:pre-wrap">{status.changelog}</pre>
</div>
{/if}

<style>
  pre { background: #0f0f23; padding: 1rem; border-radius: 6px; overflow-x: auto; }
</style>
