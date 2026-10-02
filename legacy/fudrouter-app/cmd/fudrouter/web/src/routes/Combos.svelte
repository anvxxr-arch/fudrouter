<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let combos = $state([])
  let loading = $state(true)
  
  onMount(async () => {
    try {
      combos = await api.getCombos()
    } catch (e) {
      console.error(e)
    }
    loading = false
  })
</script>

<h1>Combos</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if combos.length > 0}
  <div class="grid grid-2">
    {#each combos as combo}
      <div class="card">
        <h3>{combo.name}</h3>
        <p class="muted" style="font-size:.8rem">{combo.kind || 'combo'}</p>
        {#if combo.models}
          <div style="margin-top:.5rem">
            <span class="badge badge-active">{combo.models.length} models</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <div class="empty">
    <p class="muted">No combos configured</p>
    <p class="muted" style="font-size:.8rem">Combos let you chain multiple models together for complex workflows.</p>
  </div>
{/if}

<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 3rem; text-align: center; }
</style>
