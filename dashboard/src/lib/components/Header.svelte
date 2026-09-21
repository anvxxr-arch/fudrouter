<script lang="ts">
  import { usageStats, activeView, refreshOAuth } from '../stores/app';

  async function handleRefreshOAuth() {
    await refreshOAuth();
  }
</script>

<header class="h-14 bg-card border-b border-border flex items-center justify-between px-6 shrink-0">
  <div class="flex items-center gap-4">
    <h2 class="text-lg font-semibold text-white capitalize">{$activeView}</h2>
  </div>

  <div class="flex items-center gap-3">
    {#if $usageStats}
      <div class="flex items-center gap-4 text-xs text-gray-400">
        <span>Requests: <span class="text-white font-mono">{$usageStats.totalRequests}</span></span>
        <span>Cost: <span class="text-mint font-mono">${$usageStats.cost.toFixed(4)}</span></span>
        <span>Errors: <span class="text-red-400 font-mono">{$usageStats.errors}</span></span>
      </div>
    {/if}

    <button
      on:click={handleRefreshOAuth}
      class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border"
    >
      🔄 Refresh OAuth
    </button>
  </div>
</header>
