<script lang="ts">
  import { onMount } from 'svelte';
  import { usageStats, usageHistory, loadUsageStats } from '../stores/app';
  import { api } from '../lib/api/client';

  onMount(() => {
    loadUsageStats();
    loadHistory();
  });

  async function loadHistory() {
    try {
      const res = await api.usageHistory(50);
      usageHistory.set(res.history);
    } catch (e) {
      // ignore
    }
  }

  $: stats = $usageStats;
  $: history = $usageHistory;
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-xl font-semibold text-white">Dashboard</h3>
    <p class="text-sm text-gray-400 mt-1">Usage overview and statistics</p>
  </div>

  {#if stats}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Total Requests</p>
        <p class="text-2xl font-bold text-white">{stats.totalRequests.toLocaleString()}</p>
      </div>
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Success Rate</p>
        <p class="text-2xl font-bold text-mint">
          {stats.totalRequests > 0 ? ((stats.ok / stats.totalRequests) * 100).toFixed(1) : 0}%
        </p>
      </div>
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Total Cost</p>
        <p class="text-2xl font-bold text-glow">${stats.cost.toFixed(4)}</p>
      </div>
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Errors</p>
        <p class="text-2xl font-bold text-red-400">{stats.errors.toLocaleString()}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Prompt Tokens</p>
        <p class="text-xl font-bold text-white">{stats.promptTokens.toLocaleString()}</p>
      </div>
      <div class="bg-card border border-border rounded-xl p-4">
        <p class="text-xs text-gray-400 mb-1">Completion Tokens</p>
        <p class="text-xl font-bold text-white">{stats.completionTokens.toLocaleString()}</p>
      </div>
    </div>
  {/if}

  {#if history && history.length > 0}
    <div class="bg-card border border-border rounded-xl overflow-hidden">
      <div class="px-4 py-3 border-b border-border">
        <h4 class="text-sm font-semibold text-white">Recent Requests</h4>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-gray-400 border-b border-border">
              <th class="px-4 py-2">Time</th>
              <th class="px-4 py-2">Provider</th>
              <th class="px-4 py-2">Model</th>
              <th class="px-4 py-2">Tokens</th>
              <th class="px-4 py-2">Cost</th>
              <th class="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each history.slice(0, 20) as row}
              <tr class="border-b border-border/50 hover:bg-surface/50">
                <td class="px-4 py-2 text-gray-300 font-mono text-xs">{new Date(row.timestamp).toLocaleTimeString()}</td>
                <td class="px-4 py-2 text-white">{row.provider}</td>
                <td class="px-4 py-2 text-gray-300">{row.model}</td>
                <td class="px-4 py-2 text-gray-300">{row.promptTokens + row.completionTokens}</td>
                <td class="px-4 py-2 text-mint">${row.cost.toFixed(4)}</td>
                <td class="px-4 py-2">
                  <span class="text-xs px-2 py-0.5 rounded-full {row.status === 'ok' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
                    {row.status}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
