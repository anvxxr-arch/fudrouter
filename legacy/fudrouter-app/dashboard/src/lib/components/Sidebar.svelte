<script lang="ts">
  import { activeView, logout, isAuthenticated } from '../stores/app';

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'connections', label: 'Connections', icon: '🔗' },
    { id: 'providers', label: 'Providers', icon: '🏢' },
    { id: 'models', label: 'Models', icon: '🤖' },
    { id: 'keys', label: 'API Keys', icon: '🔑' },
    { id: 'combos', label: 'Combos', icon: '🎯' },
    { id: 'logs', label: 'Logs', icon: '📋' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ] as const;
</script>

<aside class="w-64 bg-card border-r border-border flex flex-col shrink-0">
  <div class="p-4 border-b border-border">
    <h1 class="text-xl font-bold text-glow">Fudrouter</h1>
    <p class="text-xs text-gray-500 mt-0.5">One API for every provider</p>
  </div>

  <nav class="flex-1 p-2 space-y-1 overflow-auto">
    {#each navItems as item}
      <button
        on:click={() => activeView.set(item.id)}
        class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left
          {$activeView === item.id 
            ? 'bg-accent/20 text-glow border border-accent/30' 
            : 'text-gray-400 hover:bg-surface hover:text-white border border-transparent'}"
      >
        <span class="text-base">{item.icon}</span>
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <div class="p-3 border-t border-border">
    <button
      on:click={logout}
      class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-red-900/20 hover:text-red-300 transition-colors"
    >
      <span>🚪</span>
      <span>Logout</span>
    </button>
  </div>
</aside>
