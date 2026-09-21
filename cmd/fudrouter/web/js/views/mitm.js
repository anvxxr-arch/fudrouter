// View: MITM — MITM management with cert/hosts UI
var View_mitm = {
  render(container, d) {
    const mitm = d.mitmStatus || {};
    const conns = d.connections || [];

    // MITM tools configuration
    const mitmTools = [
      { id: 'antigravity', name: 'Antigravity', image: '/providers/antigravity.png', color: '#F59E0B', description: 'Google Antigravity AI' },
      { id: 'copilot', name: 'GitHub Copilot', image: '/providers/github.png', color: '#1F6FEB', description: 'GitHub Copilot API' },
      { id: 'kiro', name: 'AWS Kiro', image: '/providers/kiro.png', color: '#FF9900', description: 'AWS Kiro IDE' },
      { id: 'cursor', name: 'Cursor', image: '/providers/cursor.png', color: '#000000', description: 'Cursor IDE' },
    ];

    const getToolStatus = (toolId) => {
      const toolConns = conns.filter(c => c.provider === toolId);
      return {
        connected: toolConns.length > 0,
        active: toolConns.some(c => c.isActive),
        count: toolConns.length,
      };
    };

    const renderToolCard = (tool) => {
      const status = getToolStatus(tool.id);
      const statusPill = !status.connected
        ? UI.pill('off', 'Not configured')
        : status.active
          ? UI.pill('active', `${status.count} Active`)
          : UI.pill('warn', `${status.count} Added`);

      return `<div class="card" data-mitm-tool="${UI.esc(tool.id)}">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <img class="provider-logo" src="${UI.esc(tool.image)}" onerror="this.style.visibility='hidden'" />
            <strong>${UI.esc(tool.name)}</strong>
          </div>
          ${statusPill}
        </div>
        <div class="muted" style="font-size:.78rem">${UI.esc(tool.description)}</div>
        <div class="mt-16 btn-group">
          <button class="btn btn-sm btn-primary" data-setup-mitm="${UI.esc(tool.id)}">Setup</button>
          <button class="btn btn-sm" data-test-mitm="${UI.esc(tool.id)}">Test</button>
        </div>
      </div>`;
    };

    container.innerHTML = `
      <div class="card mb-16" style="border-color:var(--warn)">
        <div class="card-title flex-center gap-8">
          <span style="color:var(--warn)">⚠️</span> Warning
        </div>
        <div class="text-2" style="font-size:.82rem;line-height:1.6">
          MITM intercepts HTTPS traffic of IDE tools (Antigravity, GitHub Copilot, Kiro, Cursor) via local CA to redirect requests to your providers.
          This may violate Terms of Service and could result in account bans. <strong>Use at your own risk.</strong>
        </div>
      </div>

      <div class="grid grid-2 mb-24">
        <div class="card">
          <div class="card-title">MITM Proxy Status</div>
          <div class="flex-center gap-12 mb-8">
            ${UI.pill(mitm.caExists ? 'active' : 'off', mitm.caExists ? 'CA ready' : 'CA missing')}
            ${mitm.listening && (mitm.listening['443'] || mitm.listening['8443'])
              ? UI.pill('active', 'listening :443/:8443')
              : UI.pill('off', 'not listening')}
          </div>
          ${mitm.caPath ? `<div class="muted" style="font-size:.75rem;font-family:var(--mono)">${UI.esc(mitm.caPath)}</div>` : ''}
          ${mitm.targets && mitm.targets.length ? `
            <div class="mt-8"><span class="text-2" style="font-size:.78rem">Intercepted targets:</span></div>
            <div class="btn-group mt-8">${mitm.targets.map(t => `<span class="tag">${UI.esc(t)}</span>`).join('')}</div>
          ` : '<div class="mt-8 muted" style="font-size:.78rem">No targets configured</div>'}
        </div>

        <div class="card">
          <div class="card-title">Certificate Management</div>
          <p class="muted mb-12" style="font-size:.78rem">Install the CA cert into your OS/browser trust store to enable MITM interception.</p>
          <div class="btn-group">
            <a class="btn btn-primary" href="/mitm/rootCA.crt" download="fudrouter-rootCA.crt">⬇ Download CA Cert</a>
            <button class="btn" id="ca-copy-path">📋 Copy Path</button>
            <button class="btn" id="ca-regenerate">🔄 Regenerate</button>
          </div>
          <div class="mt-8 muted" style="font-size:.72rem">After installing, configure your IDE to use the proxy at <code>http://localhost:8080</code></div>
        </div>
      </div>

      <div class="card mb-16">
        <div class="card-title">MITM Tools</div>
        <div class="grid grid-4">${mitmTools.map(t => renderToolCard(t)).join('')}</div>
      </div>

      <div class="card">
        <div class="card-title">DNS Configuration</div>
        <p class="muted mb-12" style="font-size:.78rem">Add these entries to your /etc/hosts (or equivalent) to redirect IDE traffic through the MITM proxy:</p>
        <div class="code-block" id="dns-entries">
          ${this.generateHostsEntries(mitm.targets || [])}
        </div>
        <div class="mt-8 btn-group">
          <button class="btn btn-sm" id="btn-copy-hosts">📋 Copy to Clipboard</button>
        </div>
      </div>

      <!-- Setup Modal -->
      <div id="mitmSetupModal"></div>
    `;

    // Event handlers
    container.querySelector('#ca-copy-path').onclick = () => {
      const p = mitm.caPath || '~/.fudrouter/mitm/rootCA.crt';
      navigator.clipboard?.writeText(p).then(
        () => UI.toast('Path copied: ' + p, 'ok'),
        () => UI.toast(p, 'info', 6000)
      );
    };

    container.querySelector('#ca-regenerate').onclick = async () => {
      if (!await UI.confirmDialog({ title: 'Regenerate CA', message: 'This will create a new CA certificate. You will need to reinstall it on all devices.', danger: true, okText: 'Regenerate' })) return;
      try {
        const r = await API.post('/api/mitm/regenerate', {});
        if (r.ok) { UI.toast('CA regenerated ✓', 'ok'); APP.refresh(); }
        else UI.toast(r.error || 'Failed', 'error');
      } catch (e) {
        UI.toast('Failed: ' + e.message, 'error');
      }
    };

    container.querySelector('#btn-copy-hosts').onclick = () => {
      const el = container.querySelector('#dns-entries');
      navigator.clipboard?.writeText(el.textContent).then(
        () => UI.toast('Hosts entries copied', 'ok'),
        () => UI.toast('Copy failed', 'warn')
      );
    };

    container.addEventListener('click', (e) => {
      const setupMitm = e.target.closest('[data-setup-mitm]');
      const testMitm = e.target.closest('[data-test-mitm]');

      if (setupMitm) this.showMitmSetupModal(setupMitm.dataset.setupMitm, d);
      if (testMitm) this.testMitmTool(testMitm.dataset.testMitm);
    });
  },

  generateHostsEntries(targets) {
    if (!targets || !targets.length) return '# No targets configured\n# Add MITM targets to generate hosts entries';
    return targets.map(t => `127.0.0.1  ${t}`).join('\n');
  },

  showMitmSetupModal(toolId, d) {
    const mitm = d.mitmStatus || {};
    const conns = d.connections || [];
    const toolConns = conns.filter(c => c.provider === toolId);

    const { close, bodyEl, footEl } = UI.modal({
      title: `MITM Setup — ${toolId}`,
      maxWidth: '600px',
      body: `
        <div class="muted mb-12" style="font-size:.82rem">Configure ${toolId} to route through the MITM proxy.</div>

        <div class="form-group"><label>Connection</label>
          <select class="form-select" id="mitm-conn">
            ${toolConns.length > 0
              ? toolConns.map(c => `<option value="${UI.esc(c.id)}">${UI.esc(c.name || c.id)}</option>`).join('')
              : '<option value="">No connections available</option>'}
          </select></div>

        <div class="form-group"><label>Proxy URL</label>
          <input class="form-input" id="mitm-proxy" value="http://localhost:8080" /></div>

        <div class="form-group"><label>Target Hosts (one per line)</label>
          <textarea class="form-input" id="mitm-hosts" style="min-height:100px;font-family:var(--mono)">${UI.esc((mitm.targets || []).join('\n'))}</textarea></div>

        <div class="form-group"><label class="flex-center gap-8" style="cursor:pointer">
          <input type="checkbox" id="mitm-enabled" style="width:auto" /> Enable MITM for this tool</label></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
    });

    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        connectionId: bodyEl.querySelector('#mitm-conn').value,
        proxyUrl: bodyEl.querySelector('#mitm-proxy').value.trim(),
        targets: bodyEl.querySelector('#mitm-hosts').value.split('\n').map(s => s.trim()).filter(Boolean),
        enabled: bodyEl.querySelector('#mitm-enabled').checked,
      };
      try {
        const r = await API.post(`/api/mitm/${toolId}/configure`, body);
        if (r.error) { UI.toast(r.error, 'error'); return; }
        UI.toast('MITM configuration saved ✓', 'ok'); close(); APP.refresh();
      } catch (e) {
        UI.toast('Failed: ' + e.message, 'error');
      }
    };
  },

  async testMitmTool(toolId) {
    UI.toast(`Testing MITM for ${toolId}...`, 'info');
    try {
      const r = await API.post(`/api/mitm/${toolId}/test`, {});
      if (r.ok || r.status === 'ok') UI.toast(`MITM test passed for ${toolId} ✓`, 'ok');
      else UI.toast(r.error || `Test failed for ${toolId}`, 'error', 6000);
    } catch (e) {
      UI.toast(`Test failed: ${e.message}`, 'error', 6000);
    }
  },
};
