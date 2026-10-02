<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let status = $state(null)
  let loading = $state(true)
  
  onMount(async () => {
    try {
      status = await api.getMitmStatus()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
  
  function downloadCA() {
    const link = document.createElement('a')
    link.href = '/mitm/rootCA.crt'
    link.download = 'fudrouter-rootCA.crt'
    link.click()
  }
</script>

<h1>MITM Proxy</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if status}
<div class="grid grid-2">
  <div class="card">
    <h2>Status</h2>
    <div class="status-grid">
      <div class="status-item">
        <span class="muted">CA Certificate</span>
        <span class="badge" class:badge-active={status.caExists} class:badge-error={!status.caExists}>
          {status.caExists ? 'Ready' : 'Missing'}
        </span>
      </div>
      <div class="status-item">
        <span class="muted">Port 443</span>
        <span class="badge" class:badge-active={status.listening?.['443']} class:badge-error={!status.listening?.['443']}>
          {status.listening?.['443'] ? 'Listening' : 'Blocked'}
        </span>
      </div>
      <div class="status-item">
        <span class="muted">Port 8443</span>
        <span class="badge" class:badge-active={status.listening?.['8443']} class:badge-error={!status.listening?.['8443']}>
          {status.listening?.['8443'] ? 'Listening' : 'Off'}
        </span>
      </div>
      <div class="status-item">
        <span class="muted">Router</span>
        <span class="badge badge-active">{status.router || 'active'}</span>
      </div>
    </div>
    <button class="btn btn-primary" onclick={downloadCA} style="margin-top:1rem">⬇ Download CA Cert</button>
  </div>
  
  <div class="card">
    <h2>Intercepted Targets</h2>
    {#if status.targets && status.targets.length > 0}
      <ul class="target-list">
        {#each status.targets as t}
          <li>{t}</li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No targets configured</p>
    {/if}
  </div>
</div>
{:else}
  <p class="muted">MITM not available</p>
{/if}

<style>
  .status-grid { display: flex; flex-direction: column; gap: .8rem; margin-top: .8rem; }
  .status-item { display: flex; justify-content: space-between; align-items: center; }
  .target-list { list-style: none; padding: 0; margin: .8rem 0 0; }
  .target-list li { padding: .3rem 0; border-bottom: 1px solid rgba(255,255,255,0.03); font-size: .85rem; }
</style>
