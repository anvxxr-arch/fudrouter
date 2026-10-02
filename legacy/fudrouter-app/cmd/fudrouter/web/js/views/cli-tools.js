// View: CLI Tools — integration for Claude Code, Codex, Cursor, Cline, RooCode
var View_clitools = {
  tools: [
    { id: 'claude', name: 'Claude Code', image: '/providers/claude.png', color: '#D97757', description: 'Anthropic Claude Code CLI', configType: 'env' },
    { id: 'codex', name: 'OpenAI Codex', image: '/providers/codex.png', color: '#10A37F', description: 'OpenAI Codex CLI', configType: 'env' },
    { id: 'cursor', name: 'Cursor IDE', image: '/providers/cursor.png', color: '#000000', description: 'Cursor IDE with AI features', configType: 'env' },
    { id: 'cline', name: 'Cline', image: '/providers/cline.png', color: '#3B82F6', description: 'Cline VS Code extension', configType: 'env' },
    { id: 'roocode', name: 'RooCode', image: '/providers/roocode.png', color: '#8B5CF6', description: 'RooCode VS Code extension', configType: 'env' },
    { id: 'kiro', name: 'AWS Kiro', image: '/providers/kiro.png', color: '#FF9900', description: 'AWS Kiro IDE', configType: 'env' },
    { id: 'windsurf', name: 'Windsurf', image: '/providers/windsurf.png', color: '#06B6D4', description: 'Windsurf IDE', configType: 'env' },
    { id: 'antigravity', name: 'Antigravity', image: '/providers/antigravity.png', color: '#F59E0B', description: 'Antigravity (MITM)', configType: 'mitm' },
    { id: 'copilot', name: 'GitHub Copilot', image: '/providers/github.png', color: '#1F6FEB', description: 'GitHub Copilot (MITM)', configType: 'mitm' },
  ],

  render(container, d) {
    const conns = d.connections || [];
    const settings = d.settings || {};

    const getToolStatus = (toolId) => {
      const toolConns = conns.filter(c => c.provider === toolId || (toolId === 'claude' && c.provider === 'anthropic'));
      const installed = toolConns.length > 0;
      const hasFudrouter = toolConns.some(c => c.base_url && c.base_url.includes('fudrouter'));
      return { installed, hasFudrouter, connections: toolConns };
    };

    const renderToolCard = (tool) => {
      const status = getToolStatus(tool.id);
      const statusLabel = !status.installed ? 'Not installed' : status.hasFudrouter ? 'Connected' : 'Not configured';
      const statusClass = !status.installed ? 'off' : status.hasFudrouter ? 'on' : 'warn';

      return `<div class="card" data-tool="${UI.esc(tool.id)}">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <img class="provider-logo" src="${UI.esc(tool.image)}" onerror="this.style.visibility='hidden'" />
            <strong>${UI.esc(tool.name)}</strong>
          </div>
          ${UI.pill(statusClass, statusLabel)}
        </div>
        <div class="muted" style="font-size:.78rem">${UI.esc(tool.description)}</div>
        ${status.connections.length ? `<div class="mt-8 muted" style="font-size:.72rem">${status.connections.length} connection(s)</div>` : ''}
        <div class="mt-16 btn-group">
          <button class="btn btn-sm btn-primary" data-setup="${UI.esc(tool.id)}">Setup</button>
          <button class="btn btn-sm" data-test-tool="${UI.esc(tool.id)}">Test</button>
          ${tool.configType === 'mitm' ? `<button class="btn btn-sm" data-mitm="${UI.esc(tool.id)}">MITM</button>` : ''}
        </div>
      </div>`;
    };

    const regularTools = this.tools.filter(t => t.configType !== 'mitm');
    const mitmTools = this.tools.filter(t => t.configType === 'mitm');

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Configure CLI tools to route through fudrouter</div>
        <button class="btn" id="btnRefreshTools">⟳ Refresh Status</button>
      </div>

      <div class="grid grid-3 mb-24">
        ${regularTools.map(t => renderToolCard(t)).join('')}
      </div>

      ${mitmTools.length ? `
        <div class="card mb-16">
          <div class="card-title flex-center gap-8">
            <span style="color:var(--warn)">⚠️</span> MITM Tools (Intercept HTTPS traffic)
          </div>
          <div class="muted mb-12" style="font-size:.78rem">These tools require MITM proxy to intercept and redirect HTTPS traffic. Use at your own risk.</div>
          <div class="grid grid-3">${mitmTools.map(t => renderToolCard(t)).join('')}</div>
        </div>` : ''}

      <!-- Setup Modal -->
      <div id="toolSetupModal"></div>
    `;

    container.querySelector('#btnRefreshTools').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      await APP.refresh();
      btn.textContent = '⟳ Refresh Status';
      UI.toast('Status refreshed', 'ok');
    };

    container.addEventListener('click', (e) => {
      const setup = e.target.closest('[data-setup]');
      const test = e.target.closest('[data-test-tool]');
      const mitm = e.target.closest('[data-mitm]');

      if (setup) this.showSetupModal(setup.dataset.setup, d);
      if (test) this.testTool(test.dataset.testTool);
      if (mitm) APP.navigate('mitm');
    });
  },

  showSetupModal(toolId, d) {
    const tool = this.tools.find(t => t.id === toolId);
    if (!tool) return;

    const settings = d.settings || {};
    const baseUrl = settings.baseUrl || 'http://localhost:8011';
    const apiKey = settings.apiKey || '';

    const envConfigs = {
      claude: `# Claude Code — set environment variables
export ANTHROPIC_BASE_URL="${baseUrl}/v1"
export ANTHROPIC_API_KEY="${apiKey || 'your-api-key'}"
export ANTHROPIC_MODEL="claude-sonnet-4-6"

# Or use with claude CLI
claude --model claude-sonnet-4-6`,
      codex: `# OpenAI Codex — set environment variables
export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="${apiKey || 'your-api-key'}"
export OPENAI_MODEL="gpt-4"

# Or use with codex CLI
codex --model gpt-4`,
      cursor: `# Cursor IDE — add to settings.json
{
  "cursor.cpp.disabledLanguages": [],
  "cursor.general.enableAutoComplete": true
}

# Set environment variables for Cursor
ANTHROPIC_BASE_URL="${baseUrl}/v1"
ANTHROPIC_API_KEY="${apiKey || 'your-api-key'}"`,
      cline: `# Cline VS Code Extension — set environment variables
export ANTHROPIC_BASE_URL="${baseUrl}/v1"
export ANTHROPIC_API_KEY="${apiKey || 'your-api-key'}"
export ANTHROPIC_MODEL="claude-sonnet-4-6"`,
      roocode: `# RooCode VS Code Extension — set environment variables
export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="${apiKey || 'your-api-key'}"

# Or configure in RooCode settings`,
      kiro: `# AWS Kiro — set environment variables
export ANTHROPIC_BASE_URL="${baseUrl}/v1"
export ANTHROPIC_API_KEY="${apiKey || 'your-api-key'}"`,
      windsurf: `# Windsurf IDE — set environment variables
export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="${apiKey || 'your-api-key'}"`,
    };

    const config = envConfigs[toolId] || `# ${tool.name} — configure to use fudrouter
export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="${apiKey || 'your-api-key'}"`;

    const { close, bodyEl, footEl } = UI.modal({
      title: `Setup — ${tool.name}`,
      maxWidth: '700px',
      body: `
        <div class="muted mb-12" style="font-size:.82rem">Configure ${tool.name} to route through fudrouter's unified endpoint.</div>
        <div class="form-group"><label>Configuration</label>
          <textarea class="form-input" id="tool-config" style="min-height:200px;font-family:var(--mono);font-size:.78rem" readonly>${UI.esc(config)}</textarea></div>
        <div class="form-group"><label>Base URL</label>
          <input class="form-input" id="tool-baseurl" value="${UI.esc(baseUrl)}" /></div>
        <div class="form-group"><label>API Key (optional)</label>
          <input class="form-input" id="tool-apikey" type="password" placeholder="your-api-key" /></div>`,
      footer: `<button class="btn" data-c>Close</button><button class="btn btn-primary" data-copy>📋 Copy Config</button>`,
    });

    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-copy]').onclick = () => {
      const el = bodyEl.querySelector('#tool-config');
      navigator.clipboard?.writeText(el.value).then(
        () => UI.toast('Configuration copied to clipboard', 'ok'),
        () => UI.toast('Copy failed — select and copy manually', 'warn')
      );
    };
  },

  async testTool(toolId) {
    UI.toast(`Testing ${toolId} connection...`, 'info');
    try {
      const r = await API.post('/api/cli-tools/' + toolId + '/test', {});
      if (r.ok || r.status === 'ok') UI.toast(`${toolId} connection successful ✓`, 'ok');
      else UI.toast(r.error || `${toolId} test failed`, 'error', 6000);
    } catch (e) {
      UI.toast(`Test failed: ${e.message}`, 'error', 6000);
    }
  },
};
