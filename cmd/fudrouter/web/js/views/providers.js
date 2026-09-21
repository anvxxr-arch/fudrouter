// View: Providers — provider management with new provider wizard
var View_providers = {
  state: { filter: 'all', search: '' },

  render(container, d) {
    const providers = d.providers || [];
    const conns = d.connections || [];
    const customProviders = d.customProviders || [];

    const filterOptions = [
      { value: 'all', label: 'All' },
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
      { value: 'none', label: 'No connection' },
    ];

    // Group providers by type
    const oauthProviders = providers.filter(p => p.authModes && p.authModes.includes('oauth'));
    const apiKeyProviders = providers.filter(p => p.authModes && p.authModes.includes('apikey') && !p.authModes.includes('oauth'));
    const freeProviders = providers.filter(p => p.noAuth);

    const getStats = (providerId, authType) => {
      const relevant = conns.filter(c => c.provider === providerId && (!authType || c.authType === authType));
      const connected = relevant.filter(c => c.isActive).length;
      const errors = relevant.filter(c => c.testStatus === 'error' || c.testStatus === 'expired').length;
      return { connected, errors, total: relevant.length, allDisabled: relevant.length > 0 && relevant.every(c => !c.isActive) };
    };

    const renderProviderCard = (p, authType) => {
      const stats = getStats(p.id, authType);
      const statusPill = stats.allDisabled
        ? UI.pill('off', 'Disabled')
        : stats.connected > 0
          ? UI.pill('active', `${stats.connected} Connected`)
          : stats.total > 0
            ? UI.pill('warn', `${stats.total} Added`)
            : UI.pill('off', 'No connection');

      return `<div class="card ${stats.allDisabled ? 'opacity-50' : ''}" data-prov="${UI.esc(p.id)}">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <img class="provider-logo" src="/providers/${UI.esc(p.id)}.png" onerror="this.style.visibility='hidden'" />
            <strong>${UI.esc(p.name || p.id)}</strong>
          </div>
          ${statusPill}
        </div>
        <div class="muted" style="font-size:.78rem">${UI.esc(p.description || '')}</div>
        ${stats.errors > 0 ? `<div class="mt-8 err" style="font-size:.72rem">${stats.errors} error${stats.errors > 1 ? 's' : ''}</div>` : ''}
        <div class="mt-16 btn-group">
          <button class="btn btn-sm btn-primary" data-connect="${UI.esc(p.id)}" data-auth="${UI.esc(authType || 'apikey')}">Connect</button>
          <button class="btn btn-sm" data-test="${UI.esc(p.id)}">Test</button>
        </div>
      </div>`;
    };

    const renderSection = (title, list, authType, icon) => {
      if (!list.length) return '';
      const filtered = list.filter(p => {
        if (this.state.search && !(p.name || '').toLowerCase().includes(this.state.search.toLowerCase()) && !p.id.toLowerCase().includes(this.state.search.toLowerCase())) return false;
        if (this.state.filter === 'active') return getStats(p.id, authType).connected > 0;
        if (this.state.filter === 'inactive') return getStats(p.id, authType).total > 0 && getStats(p.id, authType).allDisabled;
        if (this.state.filter === 'none') return getStats(p.id, authType).total === 0;
        return true;
      });
      return `<div class="mb-24">
        <div class="flex-between mb-12">
          <h3 class="text-lg font-semibold flex-center gap-8">
            <span style="color:var(--acc)">${icon || '●'}</span> ${UI.esc(title)}
            <span class="muted font-normal" style="font-size:.85rem">(${filtered.length})</span>
          </h3>
        </div>
        <div class="grid grid-4">${filtered.map(p => renderProviderCard(p, authType)).join('')}</div>
      </div>`;
    };

    container.innerHTML = `
      <div class="toolbar">
        <div class="search"><input class="form-input" id="provSearch" placeholder="Search providers…" value="${UI.esc(this.state.search)}" /></div>
        <select class="form-select" id="provFilter" style="max-width:180px">
          ${filterOptions.map(o => `<option value="${o.value}" ${this.state.filter === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="btnAddCustom">+ Add Custom Provider</button>
        <button class="btn" id="btnTestAll">⟳ Test All</button>
      </div>

      ${customProviders.length ? `
        <div class="card mb-16">
          <div class="card-title">Custom Providers (OpenAI/Anthropic Compatible)</div>
          <div class="grid grid-3">${customProviders.map(p => `
            <div class="card">
              <div class="flex-between mb-8">
                <strong>${UI.esc(p.name)}</strong>
                ${UI.pill(p.isActive ? 'active' : 'off', p.isActive ? 'active' : 'off')}
              </div>
              <div class="muted" style="font-size:.72rem">${UI.esc(p.baseUrl || '')}</div>
              <div class="mt-8 btn-group">
                <button class="btn btn-sm" data-edit-custom="${UI.esc(p.id)}">Edit</button>
                <button class="btn btn-sm btn-danger" data-del-custom="${UI.esc(p.id)}">✕</button>
              </div>
            </div>`).join('')}
          </div>
        </div>` : ''}

      ${renderSection('OAuth Providers', oauthProviders, 'oauth', '🔑')}
      ${renderSection('API Key Providers', apiKeyProviders, 'apikey', '🔑')}
      ${renderSection('Free Tier Providers', freeProviders, 'free', '🆓')}

      ${providers.length === 0 ? UI.empty('🔌', 'No providers available. Add a custom provider to get started.') : ''}

      <!-- New Provider Wizard Modal -->
      <div id="provWizard" class="hidden"></div>
    `;

    // Event handlers
    container.querySelector('#provSearch').addEventListener('input', e => { this.state.search = e.target.value; this.render(container, d); });
    container.querySelector('#provFilter').addEventListener('change', e => { this.state.filter = e.target.value; this.render(container, d); });

    container.querySelector('#btnAddCustom').onclick = () => this.showCustomProviderModal(null, d);
    container.querySelector('#btnTestAll').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      // Test all connections
      const results = await Promise.allSettled(conns.map(c => API.testConnection(c.id)));
      const passed = results.filter(r => r.status === 'fulfilled' && r.value.status === 'connected').length;
      btn.textContent = '⟳ Test All';
      UI.toast(`${passed}/${conns.length} tests passed`, passed === conns.length ? 'ok' : 'warn');
    };

    container.addEventListener('click', async (e) => {
      const connect = e.target.closest('[data-connect]');
      const test = e.target.closest('[data-test]');
      const editCustom = e.target.closest('[data-edit-custom]');
      const delCustom = e.target.closest('[data-del-custom]');

      if (connect) {
        const providerId = connect.dataset.connect;
        const authType = connect.dataset.auth;
        if (authType === 'oauth') {
          // Start OAuth flow
          const r = await API.oauthStart(providerId);
          if (r.authUrl) {
            window.open(r.authUrl, '_blank', 'width=520,height=720');
            UI.toast('Browser window opened — complete login there', 'info', 6000);
          } else if (r.error) {
            UI.toast(r.error, 'error');
          }
        } else {
          // Show API key connection modal
          this.showConnectModal(providerId, authType, d);
        }
      }
      if (test) {
        const btn = test; btn.innerHTML = UI.spin();
        const r = await API.testConnection(test.dataset.test);
        btn.textContent = 'Test';
        if (r.status === 'connected') UI.toast('Connected ✓', 'ok');
        else UI.toast(r.message || r.error || 'Test failed', 'error', 6000);
      }
      if (editCustom) {
        const cp = customProviders.find(x => x.id === editCustom.dataset.editCustom);
        if (cp) this.showCustomProviderModal(cp, d);
      }
      if (delCustom) {
        if (await UI.confirmDialog({ title: 'Delete custom provider', message: 'Remove this custom provider?', danger: true, okText: 'Delete' })) {
          const r = await API.deleteNode(delCustom.dataset.delCustom);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); }
          else UI.toast(r.error || 'Delete failed', 'error');
        }
      }
    });
  },

  showConnectModal(providerId, authType, d) {
    const { close, bodyEl, footEl } = UI.modal({
      title: `Connect — ${providerId}`,
      body: `
        <div class="form-group"><label>Connection Name</label>
          <input class="form-input" id="cp-name" value="${UI.esc(providerId)}" placeholder="my-${UI.esc(providerId)}" /></div>
        <div class="form-group"><label>API Key</label>
          <input class="form-input" id="cp-key" type="password" placeholder="sk-…" /></div>
        <div class="form-group"><label>Base URL (optional)</label>
          <input class="form-input" id="cp-base" placeholder="https://api.openai.com/v1" /></div>
        <div class="form-group"><label>Priority</label>
          <input class="form-input" id="cp-prio" type="number" value="10" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Connect</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        provider: providerId,
        name: bodyEl.querySelector('#cp-name').value.trim(),
        authType: authType,
        apiKey: bodyEl.querySelector('#cp-key').value.trim(),
        base_url: bodyEl.querySelector('#cp-base').value.trim(),
        priority: Number(bodyEl.querySelector('#cp-prio').value) || 0,
        isActive: true,
      };
      if (!body.name || !body.apiKey) { UI.toast('Name and API key required', 'error'); return; }
      const r = await API.createConnection(body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast('Connected ✓', 'ok'); close(); APP.refresh();
    };
  },

  showCustomProviderModal(existing, d) {
    const isNew = !existing;
    const p = existing || { name: '', prefix: '', baseUrl: '', apiKey: '', type: 'openai-compatible', apiType: 'chat' };
    const { close, bodyEl, footEl } = UI.modal({
      title: isNew ? 'Add Custom Provider' : `Edit — ${p.name}`,
      maxWidth: '600px',
      body: `
        <div class="form-row">
          <div class="form-group"><label>Name</label>
            <input class="form-input" id="cpr-name" value="${UI.esc(p.name)}" placeholder="OpenAI Compatible (Prod)" /></div>
          <div class="form-group"><label>Prefix</label>
            <input class="form-input" id="cpr-prefix" value="${UI.esc(p.prefix)}" placeholder="oc-prod" /></div>
        </div>
        <div class="form-group"><label>Type</label>
          <select class="form-select" id="cpr-type">
            <option value="openai-compatible" ${p.type === 'openai-compatible' ? 'selected' : ''}>OpenAI Compatible</option>
            <option value="anthropic-compatible" ${p.type === 'anthropic-compatible' ? 'selected' : ''}>Anthropic Compatible</option>
          </select></div>
        <div class="form-group"><label>API Type</label>
          <select class="form-select" id="cpr-apiType">
            <option value="chat" ${p.apiType === 'chat' ? 'selected' : ''}>Chat Completions</option>
            <option value="responses" ${p.apiType === 'responses' ? 'selected' : ''}>Responses API</option>
          </select></div>
        <div class="form-group"><label>Base URL</label>
          <input class="form-input" id="cpr-base" value="${UI.esc(p.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></div>
        <div class="form-group"><label>API Key (for validation)</label>
          <input class="form-input" id="cpr-key" type="password" placeholder="sk-…" /></div>
        <div class="form-group"><label>Model ID (optional, for validation)</label>
          <input class="form-input" id="cpr-model" placeholder="gpt-4" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>${isNew ? 'Create' : 'Save'}</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        name: bodyEl.querySelector('#cpr-name').value.trim(),
        prefix: bodyEl.querySelector('#cpr-prefix').value.trim(),
        type: bodyEl.querySelector('#cpr-type').value,
        apiType: bodyEl.querySelector('#cpr-apiType').value,
        baseUrl: bodyEl.querySelector('#cpr-base').value.trim(),
        apiKey: bodyEl.querySelector('#cpr-key').value.trim(),
        modelId: bodyEl.querySelector('#cpr-model').value.trim(),
      };
      if (!body.name || !body.prefix || !body.baseUrl) { UI.toast('Name, prefix, and base URL required', 'error'); return; }
      const r = isNew ? await API.createNode(body) : await API.updateNode(p.id, body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast(isNew ? 'Provider created' : 'Saved', 'ok'); close(); APP.refresh();
    };
  },
};
