<script>
  import { onMount } from 'svelte'
  import { api } from '../lib/api.js'
  
  let email = $state('')
  let password = $state('')
  let loading = $state(false)
  let error = $state(null)
  
  onMount(async () => {
    try {
      const status = await api.authStatus()
      if (status.authenticated) {
        window.location.hash = '/'
      }
    } catch (e) {
      // Not authenticated, stay on login
    }
  })
  
  async function login() {
    loading = true
    error = null
    try {
      await api.login({ email, password })
      window.location.hash = '/'
    } catch (e) {
      error = e.message
    }
    loading = false
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <div class="login-brand">
      <span class="fox">🦊</span>
      <h1>fudrouter</h1>
    </div>
    
    <p class="muted" style="text-align:center; margin-bottom:1.5rem">
      Sign in to manage your AI gateway
    </p>
    
    {#if error}
      <div class="error-msg">{error}</div>
    {/if}
    
    <div style="display:flex; flex-direction:column; gap:.8rem">
      <input class="input" type="email" placeholder="Email" bind:value={email} />
      <input class="input" type="password" placeholder="Password" bind:value={password} 
             onkeydown={(e) => e.key === 'Enter' && login()} />
      <button class="btn btn-primary" onclick={login} disabled={loading}>
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
    </div>
  </div>
</div>

<style>
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .login-card {
    background: #16213e;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 2rem;
    width: 100%;
    max-width: 380px;
  }
  .login-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: .6rem;
    margin-bottom: 1rem;
  }
  .fox { font-size: 2rem; }
  .login-brand h1 { margin: 0; color: #e8a87c; font-size: 1.5rem; }
  .error-msg {
    background: rgba(255,107,107,0.1);
    border: 1px solid #ff6b6b;
    color: #ff6b6b;
    padding: .5rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: .85rem;
  }
</style>
