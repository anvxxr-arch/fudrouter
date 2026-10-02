<script>
  import { onMount } from 'svelte'
  
  const providers = [
    { id: 'codex', name: 'OpenAI Codex', icon: '🤖', desc: 'Cloud-based coding agent' },
    { id: 'cursor', name: 'Cursor', icon: '🖱️', desc: 'AI-first code editor' },
    { id: 'kiro', name: 'Kiro', icon: '🔧', desc: 'AWS IDE with AI agent' },
    { id: 'xai', name: 'xAI / Grok', icon: '🧠', desc: 'Grok with code tools' },
    { id: 'xiaomi', name: 'Xiaomi MiMo', icon: '📱', desc: 'MiMo coding model' },
  ]
  
  function startOAuth(id) {
    window.location.href = `/api/oauth/${id}/start`
  }
</script>

<h1>OAuth Connections</h1>

<p class="muted" style="margin-bottom:1.5rem">
  Connect your AI coding agent accounts to fudrouter for automatic token refresh and usage tracking.
</p>

<div class="grid grid-2">
  {#each providers as p}
    <div class="card oauth-card">
      <div class="oauth-header">
        <span class="oauth-icon">{p.icon}</span>
        <div>
          <h3>{p.name}</h3>
          <p class="muted" style="font-size:.8rem">{p.desc}</p>
        </div>
      </div>
      <button class="btn btn-primary" onclick={() => startOAuth(p.id)}>
        Connect
      </button>
    </div>
  {/each}
</div>

<style>
  .oauth-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .oauth-header {
    display: flex;
    align-items: center;
    gap: .8rem;
  }
  .oauth-icon { font-size: 2rem; }
  .oauth-header h3 { margin: 0; font-size: 1rem; }
  .oauth-header p { margin: .2rem 0 0; }
</style>
