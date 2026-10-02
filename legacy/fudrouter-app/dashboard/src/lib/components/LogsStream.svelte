<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api/client';

  let logs: Array<{ timestamp: string; level: string; message: string; source: string }> = [];
  let connected = false;
  let error = '';
  let eventSource: EventSource | null = null;

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    if (eventSource) {
      eventSource.close();
    }
  });

  function connect() {
    eventSource = new EventSource(`${api.baseUrl}/api/logs/stream`);
    
    eventSource.onopen = () => {
      connected = true;
      error = '';
    };

    eventSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        logs = [entry, ...logs].slice(0, 100);
      } catch (e) {
        // ignore parse errors
      }
    };

    eventSource.onerror = () => {
      connected = false;
      error = 'Connection lost. Retrying...';
      eventSource?.close();
      setTimeout(connect, 3000);
    };
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-xl font-semibold text-white">Logs</h3>
      <p class="text-sm text-gray-400 mt-1">Real-time request logs</p>
    </div>
    <div class="flex items-center gap-2">
      <span class="w-2 h-2 rounded-full {connected ? 'bg-green-400' : 'bg-red-400'}"></span>
      <span class="text-xs text-gray-400">{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  </div>

  {#if error}
    <div class="bg-yellow-900/30 border border-yellow-800 text-yellow-300 px-4 py-3 rounded-lg text-sm">{error}</div>
  {/if}

  <div class="bg-card border border-border rounded-xl overflow-hidden">
    <div class="px-4 py-2 border-b border-border flex items-center justify-between">
      <span class="text-xs text-gray-400">{logs.length} entries</span>
      <button
        on:click={() => logs = []}
        class="text-xs text-gray-400 hover:text-white transition-colors"
      >
        Clear
      </button>
    </div>
    <div class="max-h-[600px] overflow-auto">
      {#each logs as log}
        <div class="px-4 py-2 border-b border-border/50 font-mono text-xs hover:bg-surface/50">
          <span class="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
          <span class="ml-2 {log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-green-400'}">[{log.level.toUpperCase()}]</span>
          <span class="ml-2 text-gray-300">{log.message}</span>
        </div>
      {/each}
      {#if logs.length === 0}
        <div class="px-4 py-8 text-center text-gray-500 text-sm">No logs yet</div>
      {/if}
    </div>
  </div>
</div>
