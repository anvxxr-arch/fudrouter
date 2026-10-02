// View: Connections — CRUD + test + OAuth quick links
var View_connections = {
  render(container, d) {
    const conns = d.connections || [];
    container.innerHTML = `
      <div class="toolbar">
        <div class="search"><input class="form-input" id="connSearch" placeholder="Search connections…" /></div>
        <button class="btn btn-primary" id="btnAddConn">+ Add Connection</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Provider</th><th>Name</th><th>Auth</th><th>Priority</th><th>Status</th><th>Base URL</th><th></th></tr></thead>
          <tbody id="connRows"></tbody>
        </table>
      </div>`;

    const rowsEl = container.querySelector('#connRows');
    const renderRows = (filter = '') => {
      const f = filter.toLowerCase();
      const list = conns.filter(c =>
        !f || (c.name || '').toLowerCase().includes(f) || (c.provider || '').toLowerCase().includes(f));
      if (!list.length) { rowsEl.innerHTML = `<tr><td colspan="7">${UI.empty('🔌', 'No connections')}</td></tr>`; return; }
      rowsEl.innerHTML = list.map(c => `
        <tr>
          <td><div class="flex-center gap-8">
            <img class="provider-logo" src="/providers/${UI.esc(c.provider)}.png" onerror="this.style.visibility='hidden'" />
            <span>${UI.esc(c.provider)}</span></div></td>
          <td>${UI.esc(c.name)}</td>
          <td><span class="tag">${UI.esc(c.authType)}</span></td>
          <td>${c.priority ?? '—'}</td>
          <td>${UI.pill(c.isActive ? 'active' : 'off', c.isActive ? 'active' : 'off')}</td>
          <td class="muted">${UI.esc(UI.truncate(c.base_url || c.data?.baseUrl || '', 36))}</td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-sm" data-test="${UI.esc(c.id)}">Test</button>
              <button class="btn btn-sm" data-edit="${UI.esc(c.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-del="${UI.esc(c.id)}">✕</button>
            </div>
          </td>
        </tr>`).join('');
    };
    renderRows();
    container.querySelector('#connSearch').addEventListener('input', e => renderRows(e.target.value));
    container.querySelector('#btnAddConn').onclick = () => this.editModal(null, conns);

    rowsEl.addEventListener('click', async (e) => {
      const test = e.target.closest('[data-test]');
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (test) {
        const btn = test; btn.innerHTML = UI.spin();
        const r = await API.testConnection(btn.dataset.test);
        btn.textContent = 'Test';
        if (r.status === 'connected') UI.toast('Connected ✓', 'ok');
        else UI.toast(r.message || r.error || 'Test failed', 'error', 6000);
      }
      if (edit) {
        const c = conns.find(x => x.id === edit.dataset.edit);
        if (c) this.editModal(c, conns);
      }
      if (del) {
        const c = conns.find(x => x.id === del.dataset.del);
        if (c && await UI.confirmDialog({ title: 'Delete connection', message: `Delete "${c.name}"? This cannot be undone.`, danger: true, okText: 'Delete' })) {
          const r = await API.deleteConnection(c.id);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); }
          else UI.toast(r.error || 'Delete failed', 'error');
        }
      }
    });
  },

  editModal(conn, allConns) {
    const isNew = !conn;
    const c = conn || { provider: '', name: '', authType: 'apikey', priority: 10, isActive: true, base_url: '', apiKey: '' };
    const { close, bodyEl, footEl } = UI.modal({
      title: isNew ? 'Add Connection' : `Edit — ${c.name}`,
      body: `
        <div class="form-row">
          <div class="form-group"><label>Provider</label>
            <input class="form-input" id="cf-provider" value="${UI.esc(c.provider)}" placeholder="openai" /></div>
          <div class="form-group"><label>Name</label>
            <input class="form-input" id="cf-name" value="${UI.esc(c.name)}" placeholder="my-openai" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Auth Type</label>
            <select class="form-select" id="cf-auth">
              ${['apikey', 'oauth'].map(a => `<option value="${a}" ${c.authType === a ? 'selected' : ''}>${a}</option>`).join('')}
            </select></div>
          <div class="form-group"><label>Priority</label>
            <input class="form-input" id="cf-prio" type="number" value="${c.priority ?? 10}" /></div>
        </div>
        <div class="form-group"><label>Base URL</label>
          <input class="form-input" id="cf-base" value="${UI.esc(c.base_url || c.data?.baseUrl || '')}" placeholder="https://api.openai.com" /></div>
        <div class="form-group"><label>API Key ${isNew ? '' : '(leave blank to keep)'}</label>
          <input class="form-input" id="cf-key" type="password" placeholder="sk-…" /></div>
        <div class="form-group"><label class="flex-center gap-8" style="cursor:pointer">
          <input type="checkbox" id="cf-active" ${c.isActive ? 'checked' : ''} style="width:auto" /> Active</label></div>
      `,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>${isNew ? 'Create' : 'Save'}</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        provider: bodyEl.querySelector('#cf-provider').value.trim(),
        name: bodyEl.querySelector('#cf-name').value.trim(),
        authType: bodyEl.querySelector('#cf-auth').value,
        priority: Number(bodyEl.querySelector('#cf-prio').value) || 0,
        base_url: bodyEl.querySelector('#cf-base').value.trim(),
        isActive: bodyEl.querySelector('#cf-active').checked,
      };
      const key = bodyEl.querySelector('#cf-key').value.trim();
      if (key) body.apiKey = key;
      if (!body.provider || !body.name) { UI.toast('Provider and name required', 'error'); return; }
      const r = isNew ? await API.createConnection(body) : await API.updateConnection(conn.id, body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast(isNew ? 'Connection created' : 'Saved', 'ok');
      close(); APP.refresh();
    };
  },
};
