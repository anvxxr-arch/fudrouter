<script>
  import { onMount } from 'svelte'
  
  let logs = $state([])
  let filter = $state('all')
  let autoScroll = $state(true)
  
  onMount(() => {
    // Connect to SSE log stream
    if (typeof EventSource !== 'undefined') {
      const es = new EventSource('/api/logs/stream')
      es.onmessage = (e) => {
        logs = [...logs, JSON.parse(e.data)]
        if (autoScroll && logs.length > 100) logs = logs.slice(-100)
      }
    }
  })
  
  let filteredLogs = $derived(filter === 'all' ? logs : logs.filter(l => l.level === filter))
  
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString()
  }
  
  const levels = ['all', 'info', 'warn', 'error', 'debug']
</script>

<h1>Live Logs</h1>

<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem">
  <div style="display:flex; gap:.3rem">
    {#each levels as l}
      <button class="btn btn-ghost" class:btn-primary={filter === l} 
              style="padding:.3rem .6rem; font-size:.75rem" 
              onclick={() => filter = l}>{l}</button>
    {/each}
  </div>
  <label class="muted" style="display:flex; align-items:center; gap:.3rem">
    <input type="checkbox" bind:checked={autoScroll} />
    Auto-scroll
  </label>
</div>

<div class="card log-viewer">
  {#if filteredLogs.length > 0}
    {#each filteredLogs as log}
      <div class="log-line log-{log.level || 'info'}">
        <span class="log-time">{fmtTime(log.timestamp || Date.now())}</span>
        <span class="log-level">{log.level || 'info'}</span>
        <span class="log-msg">{log.message || log}</span>
      </div>
    {/each}
  {:else}
    <p class="muted" style="text-align:center; padding:2rem">No logs yet</p>
  {/if}
</div>

<style>
  .log-viewer { 
    max-height: calc(100vh - 200px); 
    overflow-y: auto; 
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: .8rem;
    padding: 0;
  }
  .log-line { 
    display: flex; 
    gap: .8rem; 
    padding: .3rem .8rem; 
    border-bottom: 1px solid rgba(255,255,255,0.02);
  }
  .log-time { color: #666; }
  .log-level { 
    min-width: 45px; 
    font-weight: 600; 
    font-size: .7rem;
    padding: 0 .3rem;
    border-radius: 3px;
    text-align: center;
  }
  .log-info .log-level { color: #4a9eff; background: rgba(74,158,255,0.1); }
  .log-warn .log-level { color: #fbbf24; background: rgba(251,191,36,0.1); }
  .log-error .log-level { color: #ff6b6b; background: rgba(255,107,107,0.1); }
  .log-debug .log-level { color: #888; background: rgba(136,136,170,0.1); }
  .log-msg { flex: 1; }
</style>
