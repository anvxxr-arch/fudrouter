<script lang="ts">
  import { login, isLoading, error } from '../stores/app';

  let password = '';
  let showPassword = false;

  async function handleLogin() {
    if (!password) return;
    await login(password);
    password = '';
  }
</script>

<div class="min-h-screen bg-ink flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-glow mb-2">Fudrouter</h1>
      <p class="text-gray-400">One API for every provider</p>
    </div>

    <div class="bg-card border border-border rounded-xl p-6">
      <h2 class="text-xl font-semibold text-white mb-4">Login</h2>

      <form on:submit|preventDefault={handleLogin} class="space-y-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Password</label>
          <div class="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              bind:value={password}
              class="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-accent transition-colors"
              placeholder="Enter password"
              autofocus
            />
            <button
              type="button"
              on:click={() => showPassword = !showPassword}
              class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showPassword ? '🙈' : '👁️'}
            </button>
          </div>
        </div>

        {#if $error}
          <div class="bg-red-900/30 border border-red-800 text-red-300 px-3 py-2 rounded-lg text-sm">
            {$error}
          </div>
        {/if}

        <button
          type="submit"
          disabled={$isLoading || !password}
          class="w-full bg-accent hover:bg-glow disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
        >
          {$isLoading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>

    <p class="text-center text-gray-600 text-xs mt-4">
      Fudrouter v1.0.0 — Go API + Svelte Dashboard
    </p>
  </div>
</div>
