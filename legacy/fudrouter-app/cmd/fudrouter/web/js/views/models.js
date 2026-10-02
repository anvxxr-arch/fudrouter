// View: Models — catalog browser with search, aliases, disabled
var View_models = {
  state: { search: '', provider: '' },

  render(container, d) {
    const providers = d.providers || [];
    const models = d.modelsAvailability || [];
    container.innerHTML = `
      <div class="toolbar">
        <div class="search"><input class="form-input" id="mSearch" placeholder="Search models…" value="${UI.esc(this.state.search)}" /></div>
        <select class="form-select" id="mProv" style="max-width:220px">
          <option value="">All providers</option>
          ${providers.map(p => `<option value="${UI.esc(p.id)}" ${this.state.provider === p.id ? 'selected' : ''}>${UI.esc(p.name || p.id)}</option>`).join('')}
        </select>
        <button class="btn" id="btnSync">⟳ Sync Catalog</button>
      </div>
      <div class="grid" style="margin-bottom:16px">
        <div class="card stat-card"><div class="value">${providers.length}</div><div class="label">Providers</div></div>
        <div class="card stat-card"><div class="value">${UI.num(models.length)}</div><div class="label">Models</div></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Model</th><th>Provider</th><th>Owner</th><th></th></tr></thead>
          <tbody id="mRows"></tbody>
        </table>
      </div>`;

    const rowsEl = container.querySelector('#mRows');
    const renderRows = () => {
      const f = this.state.search.toLowerCase();
      const prov = this.state.provider;
      const list = models.filter(m => {
        const mid = m.id || '';
        const mp = m.provider || m.owned_by || (mid.includes('/') ? mid.split('/')[0] : '');
        if (prov && mp !== prov) return false;
        return !f || mid.toLowerCase().includes(f);
      });
      if (!list.length) { rowsEl.innerHTML = `<tr><td colspan="4">${UI.empty('🧠', 'No models found')}</td></tr>`; return; }
      rowsEl.innerHTML = list.slice(0, 300).map(m => {
        const mid = m.id || '';
        const prov = m.provider || m.owned_by || (mid.includes('/') ? mid.split('/')[0] : '');
        return `<tr>
          <td><code>${UI.esc(mid)}</code></td>
          <td><div class="flex-center gap-8">
            <img class="provider-logo" src="/providers/${UI.esc(prov)}.png" onerror="this.style.visibility='hidden'" />
            ${UI.esc(prov)}</div></td>
          <td class="muted">${UI.esc(m.owned_by || '—')}</td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-sm" data-chat="${UI.esc(mid)}">Chat</button>
            </div>
          </td>
        </tr>`;
      }).join('') + (list.length > 300 ? `<tr><td colspan="4" class="muted text-center">… ${list.length - 300} more (use search)</td></tr>` : '');
    };
    renderRows();

    container.querySelector('#mSearch').addEventListener('input', e => { this.state.search = e.target.value; renderRows(); });
    container.querySelector('#mProv').addEventListener('change', e => { this.state.provider = e.target.value; renderRows(); });
    container.querySelector('#btnSync').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const r = await API.catalogSync();
      btn.innerHTML = '⟳ Sync Catalog';
      if (r.ok) { UI.toast(`Synced: ${r.providers} providers, ${r.models} models`, 'ok'); APP.refresh(); }
      else UI.toast(r.error || 'Sync failed', 'error');
    };
    rowsEl.addEventListener('click', (e) => {
      const chat = e.target.closest('[data-chat]');
      if (chat) { sessionStorage.setItem('fudrouter_chat_model', chat.dataset.chat); APP.navigate('chat'); }
    });
  },
};
