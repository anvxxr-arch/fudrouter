<script lang="ts">
  import { onMount } from 'svelte';
  import { settings, loadSettings, patchSettings } from '../stores/app';

  onMount(() => {
    loadSettings();
  });

  let newPassword = '';
  let showPassword = false;

  async function handleSetPassword() {
    if (!newPassword) return;
    await patchSettings({ password: newPassword });
    newPassword = '';
    alert('Password updated!');
  }

  async function handleToggleLogin() {
    await patchSettings({ requireLogin: !$settings.requireLogin });
  }

  async function handleChangeStrategy(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    await patchSettings({ fallbackStrategy: value });
  }
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-xl font-semibold text-white">Settings</h3>
    <p class="text-sm text-gray-400 mt-1">Configure your Fudrouter instance</p>
  </div>

  <div class="bg-card border border-border rounded-xl p-4 space-y-4">
    <h4 class="text-sm font-semibold text-white">Security</h4>
    
    <div class="flex items-center justify-between">
      <div>
        <p class="text-sm text-white">Require Login</p>
        <p class="text-xs text-gray-400">Force authentication for dashboard access</p>
      </div>
      <button
        on:click={handleToggleLogin}
        class="relative w-12 h-6 rounded-full transition-colors {$settings.requireLogin ? 'bg-accent' : 'bg-gray-700'}"
      >
        <span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {$settings.requireLogin ? 'translate-x-6' : ''}"></span>
      </button>
    </div>

    <div>
      <label class="block text-xs text-gray-400 mb-1">Change Password</label>
      <div class="flex gap-2">
        <input
          type={showPassword ? 'text' : 'password'}
          bind:value={newPassword}
          class="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"
          placeholder="New password"
        />
        <button
          on:click={handleSetPassword}
          class="bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          Set
        </button>
      </div>
    </div>
  </div>

  <div class="bg-card border border-border rounded-xl p-4 space-y-4">
    <h4 class="text-sm font-semibold text-white">Routing</h4>
    
    <div>
      <label class="block text-xs text-gray-400 mb-1">Fallback Strategy</label>
      <select
        value={$settings.fallbackStrategy || 'fill-first'}
        on:change={handleChangeStrategy}
        class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"
      >
        <option value="fill-first">Fill First (priority order)</option>
        <option value="race">Race (fastest wins)</option>
      </select>
    </div>
  </div>

  <div class="bg-card border border-border rounded-xl p-4 space-y-4">
    <h4 class="text-sm font-semibold text-white">API</h4>
    <div>
      <p class="text-xs text-gray-400 mb-2">API Base URL</p>
      <code class="text-xs bg-surface text-glow px-3 py-1.5 rounded-lg block">http://127.0.0.1:8011</code>
    </div>
  </div>
</div>
