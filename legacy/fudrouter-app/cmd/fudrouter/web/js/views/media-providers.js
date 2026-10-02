// View: Media Providers — TTS, Image Gen, Web Search, Embeddings, STT
var View_mediaprov = {
  render(container, d) {
    const conns = d.connections || [];
    const combos = d.combos || [];

    // Media provider categories with their kinds
    const categories = [
      { id: 'tts', name: 'Text-to-Speech', icon: '🔊', description: 'Convert text to audio using TTS providers' },
      { id: 'image', name: 'Image Generation', icon: '🖼️', description: 'Generate images from text prompts' },
      { id: 'web', name: 'Web Search', icon: '🔍', description: 'Search the web and fetch content' },
      { id: 'embeddings', name: 'Embeddings', icon: '📐', description: 'Generate vector embeddings from text' },
      { id: 'stt', name: 'Speech-to-Text', icon: '🎤', description: 'Convert audio to text using transcription' },
    ];

    // Provider availability per kind
    const providersByKind = d.mediaProvidersByKind || {};
    const combosByKind = {};
    combos.forEach(c => {
      const kind = c.kind || 'tts';
      if (!combosByKind[kind]) combosByKind[kind] = [];
      combosByKind[kind].push(c);
    });

    const getProviderStats = (providerId) => {
      const pc = conns.filter(c => c.provider === providerId);
      return {
        connected: pc.filter(c => c.isActive).length,
        total: pc.length,
      };
    };

    const renderProviderCard = (provider, kind) => {
      const stats = getProviderStats(provider.id);
      const statusPill = stats.connected > 0
        ? UI.pill('active', `${stats.connected} Connected`)
        : stats.total > 0
          ? UI.pill('warn', `${stats.total} Added`)
          : UI.pill('off', 'No connection');

      return `<div class="card">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <img class="provider-logo" src="/providers/${UI.esc(provider.id)}.png" onerror="this.style.visibility='hidden'" />
            <strong>${UI.esc(provider.name)}</strong>
          </div>
          ${statusPill}
        </div>
        <div class="muted" style="font-size:.78rem">${UI.esc(provider.description || '')}</div>
        <div class="mt-16 btn-group">
          <button class="btn btn-sm btn-primary" data-connect-media="${UI.esc(provider.id)}" data-kind="${UI.esc(kind)}">Connect</button>
          <button class="btn btn-sm" data-test-media="${UI.esc(provider.id)}" data-kind="${UI.esc(kind)}">Test</button>
        </div>
      </div>`;
    };

    const renderComboCard = (combo, kind) => {
      return `<div class="card">
        <div class="flex-between mb-8">
          <div class="flex-center gap-8">
            <span style="color:var(--acc)">🔗</span>
            <code style="font-size:.85rem">${UI.esc(combo.name)}</code>
          </div>
          ${UI.pill('active', `${combo.models?.length || 0} models`)}
        </div>
        <div class="muted mb-8" style="font-size:.78rem">Kind: ${UI.esc(kind)}</div>
        ${combo.models?.length ? `
          <div class="flex-center gap-4" style="flex-wrap:wrap">
            ${combo.models.slice(0, 6).map(m => `
              <img class="provider-logo" style="width:20px;height:20px" src="/providers/${UI.esc(String(m).split('/')[0])}.png" title="${UI.esc(m)}" onerror="this.style.visibility='hidden'" />
            `).join('')}
            ${combo.models.length > 6 ? `<span class="muted" style="font-size:.72rem">+${combo.models.length - 6}</span>` : ''}
          </div>` : ''}
        <div class="mt-12 btn-group">
          <button class="btn btn-sm" data-edit-combo="${UI.esc(combo.id)}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del-combo="${UI.esc(combo.id)}">✕</button>
        </div>
      </div>`;
    };

    const renderCategory = (category) => {
      const providers = providersByKind[category.id] || [];
      const categoryCombos = combosByKind[category.id] || [];

      return `<div class="mb-24">
        <div class="flex-between mb-12">
          <h3 class="text-lg font-semibold flex-center gap-8">
            <span style="color:var(--acc)">${category.icon}</span> ${UI.esc(category.name)}
            <span class="muted font-normal" style="font-size:.85rem">(${providers.length} providers · ${categoryCombos.length} combos)</span>
          </h3>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary" data-create-combo="${UI.esc(category.id)}">+ Create Combo</button>
            <button class="btn btn-sm" data-test-all="${UI.esc(category.id)}">⟳ Test All</button>
          </div>
        </div>
        <p class="muted mb-12" style="font-size:.78rem">${UI.esc(category.description)}</p>

        ${categoryCombos.length ? `
          <div class="card mb-16">
            <div class="card-title">Combos</div>
            <div class="grid grid-3">${categoryCombos.map(c => renderComboCard(c, category.id)).join('')}</div>
          </div>` : ''}

        ${providers.length > 0
          ? `<div class="grid grid-4">${providers.map(p => renderProviderCard(p, category.id)).join('')}</div>`
          : `<div class="card text-center py-24">
              ${UI.empty('📦', `No ${category.name} providers available`)}
              <p class="muted mt-8">Connect a provider to enable ${category.name.toLowerCase()} through fudrouter.</p>
            </div>`}
      </div>`;
    };

    // API endpoint info
    const endpoints = [
      { path: '/api/v1/audio/speech', method: 'POST', desc: 'Text-to-Speech' },
      { path: '/api/v1/images/generations', method: 'POST', desc: 'Image Generation' },
      { path: '/api/v1/embeddings', method: 'POST', desc: 'Embeddings' },
      { path: '/api/v1/audio/transcriptions', method: 'POST', desc: 'Speech-to-Text' },
      { path: '/api/v1/web/fetch', method: 'POST', desc: 'Web Fetch' },
    ];

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Manage media providers for TTS, image generation, web search, and more</div>
        <button class="btn" id="btnRefreshMedia">⟳ Refresh</button>
      </div>

      ${categories.map(c => renderCategory(c)).join('')}

      <div class="card">
        <div class="card-title">API Endpoints</div>
        <p class="muted mb-12" style="font-size:.78rem">All media endpoints are accessible via the v1 API. Use the configured API key for authentication.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead>
            <tbody>
              ${endpoints.map(e => `
                <tr>
                  <td><span class="tag" style="font-family:var(--mono)">${UI.esc(e.method)}</span></td>
                  <td><code>${UI.esc(e.path)}</code></td>
                  <td class="muted">${UI.esc(e.desc)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Event handlers
    container.querySelector('#btnRefreshMedia').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      await APP.refresh();
      btn.textContent = '⟳ Refresh';
    };

    container.addEventListener('click', async (e) => {
      const connect = e.target.closest('[data-connect-media]');
      const test = e.target.closest('[data-test-media]');
      const testAll = e.target.closest('[data-test-all]');
      const createCombo = e.target.closest('[data-create-combo]');
      const editCombo = e.target.closest('[data-edit-combo]');
      const delCombo = e.target.closest('[data-del-combo]');

      if (connect) {
        const providerId = connect.dataset.connectMedia;
        const kind = connect.dataset.kind;
        // Show connection modal
        this.showConnectMediaModal(providerId, kind, d);
      }

      if (test) {
        const btn = test; btn.innerHTML = UI.spin();
        try {
          const r = await API.post(`/api/media-providers/${test.dataset.kind}/test`, { provider: test.dataset.testMedia });
          btn.textContent = 'Test';
          if (r.ok) UI.toast(`${test.dataset.kind} test passed ✓`, 'ok');
          else UI.toast(r.error || 'Test failed', 'error', 6000);
        } catch (err) {
          btn.textContent = 'Test';
          UI.toast(`Test failed: ${err.message}`, 'error');
        }
      }

      if (testAll) {
        const btn = testAll; btn.innerHTML = UI.spin();
        const providers = providersByKind[testAll.dataset.testAll] || [];
        const results = await Promise.allSettled(providers.map(p =>
          API.post(`/api/media-providers/${testAll.dataset.testAll}/test`, { provider: p.id })
        ));
        btn.textContent = '⟳ Test All';
        const passed = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
        UI.toast(`${passed}/${providers.length} tests passed`, passed === providers.length ? 'ok' : 'warn');
      }

      if (createCombo) {
        this.showCreateComboModal(createCombo.dataset.createCombo, d);
      }

      if (editCombo) {
        const combo = combos.find(c => c.id === editCombo.dataset.editCombo);
        if (combo) this.showEditComboModal(combo, d);
      }

      if (delCombo) {
        if (await UI.confirmDialog({ title: 'Delete combo', message: 'Delete this combo?', danger: true, okText: 'Delete' })) {
          const r = await API.deleteCombo(delCombo.dataset.delCombo);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); }
          else UI.toast(r.error || 'Delete failed', 'error');
        }
      }
    });
  },

  showConnectMediaModal(providerId, kind, d) {
    const conns = d.connections || [];
    const providerConns = conns.filter(c => c.provider === providerId);

    const { close, bodyEl, footEl } = UI.modal({
      title: `Connect ${providerId} (${kind})`,
      body: `
        <div class="form-group"><label>Connection Name</label>
          <input class="form-input" id="mp-name" value="${UI.esc(providerId)}" /></div>
        <div class="form-group"><label>API Key</label>
          <input class="form-input" id="mp-key" type="password" placeholder="sk-…" /></div>
        <div class="form-group"><label>Base URL (optional)</label>
          <input class="form-input" id="mp-base" placeholder="https://api.openai.com/v1" /></div>
        <div class="form-group"><label>Priority</label>
          <input class="form-input" id="mp-prio" type="number" value="10" /></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Connect</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        provider: providerId,
        name: bodyEl.querySelector('#mp-name').value.trim(),
        authType: 'apikey',
        apiKey: bodyEl.querySelector('#mp-key').value.trim(),
        base_url: bodyEl.querySelector('#mp-base').value.trim(),
        priority: Number(bodyEl.querySelector('#mp-prio').value) || 0,
        isActive: true,
        kind: kind,
      };
      if (!body.name || !body.apiKey) { UI.toast('Name and API key required', 'error'); return; }
      const r = await API.createConnection(body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast('Connected ✓', 'ok'); close(); APP.refresh();
    };
  },

  showCreateComboModal(kind, d) {
    const { close, bodyEl, footEl } = UI.modal({
      title: `Create Combo (${kind})`,
      body: `
        <div class="form-group"><label>Combo Name</label>
          <input class="form-input" id="combo-name" placeholder="my-${kind}-combo" /></div>
        <div class="form-group"><label>Models (comma-separated, provider/model format)</label>
          <textarea class="form-input" id="combo-models" style="min-height:80px" placeholder="openai/tts-1, elevenlabs/monolingual-v1"></textarea></div>
        <div class="form-group"><label>Strategy</label>
          <select class="form-select" id="combo-strategy">
            <option value="fill-first">fill-first</option>
            <option value="round-robin">round-robin</option>
            <option value="race">race</option>
          </select></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Create</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const name = bodyEl.querySelector('#combo-name').value.trim();
      const models = bodyEl.querySelector('#combo-models').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!name) { UI.toast('Name required', 'error'); return; }
      const body = { name, models, kind, strategy: bodyEl.querySelector('#combo-strategy').value };
      const r = await API.createCombo(body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast('Combo created ✓', 'ok'); close(); APP.refresh();
    };
  },

  showEditComboModal(combo, d) {
    const { close, bodyEl, footEl } = UI.modal({
      title: `Edit Combo — ${combo.name}`,
      body: `
        <div class="form-group"><label>Combo Name</label>
          <input class="form-input" id="combo-name" value="${UI.esc(combo.name)}" /></div>
        <div class="form-group"><label>Models (comma-separated)</label>
          <textarea class="form-input" id="combo-models" style="min-height:80px">${UI.esc((combo.models || []).join(', '))}</textarea></div>
        <div class="form-group"><label>Strategy</label>
          <select class="form-select" id="combo-strategy">
            <option value="fill-first" ${combo.strategy === 'fill-first' ? 'selected' : ''}>fill-first</option>
            <option value="round-robin" ${combo.strategy === 'round-robin' ? 'selected' : ''}>round-robin</option>
            <option value="race" ${combo.strategy === 'race' ? 'selected' : ''}>race</option>
          </select></div>`,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        name: bodyEl.querySelector('#combo-name').value.trim(),
        models: bodyEl.querySelector('#combo-models').value.split(',').map(s => s.trim()).filter(Boolean),
        strategy: bodyEl.querySelector('#combo-strategy').value,
      };
      const r = await API.updateCombo(combo.id, body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast('Combo updated ✓', 'ok'); close(); APP.refresh();
    };
  },
};
