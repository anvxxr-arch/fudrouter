<script>
  const tools = [
    { id: 'claude', name: 'Claude Code', env: 'ANTHROPIC_BASE_URL', desc: 'AI coding assistant by Anthropic' },
    { id: 'kiro', name: 'Kiro', env: 'KIRO_API_KEY', desc: 'AWS IDE with AI agent' },
    { id: 'cursor', name: 'Cursor', env: 'CURSOR_API_KEY', desc: 'AI-first code editor' },
    { id: 'copilot', name: 'GitHub Copilot', env: 'COPILOT_API_KEY', desc: 'AI pair programmer' },
    { id: 'windsurf', name: 'Windsurf', env: 'WINDSURF_API_KEY', desc: 'AI coding agent' },
    { id: 'codex', name: 'OpenAI Codex', env: 'OPENAI_API_KEY', desc: 'Cloud coding agent' },
  ]
  
  function configCmd(tool) {
    return `# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export ${tool.env}="http://localhost:8011/v1/chat/completions"
export ${tool.env.replace('_API_KEY', '_API_KEY')}="your-fudrouter-key"`
  }
  
  function copyCmd(tool) {
    navigator.clipboard.writeText(configCmd(tool))
  }
</script>

<h1>CLI Tools</h1>

<p class="muted" style="margin-bottom:1rem">
  Configure your CLI coding agents to route through fudrouter's unified endpoint.
</p>

<div class="grid grid-2">
  {#each tools as t}
    <div class="card tool-card">
      <div class="tool-header">
        <h3>{t.name}</h3>
        <button class="btn btn-ghost" onclick={() => copyCmd(t)} title="Copy config">📋</button>
      </div>
      <p class="muted" style="font-size:.8rem">{t.desc}</p>
      <code class="cmd-block">{configCmd(t)}</code>
    </div>
  {/each}
</div>

<style>
  .tool-card { display: flex; flex-direction: column; gap: .5rem; }
  .tool-header { display: flex; justify-content: space-between; align-items: start; }
  .cmd-block { display: block; padding: .5rem; background: #0f0f23; border-radius: 6px; font-size: .7rem; color: #8888aa; overflow-x: auto; white-space: pre; }
</style>
