// View: Proxy Pools
var View_proxypools = {
  render(container, d) {
    const pools = d.pools || [];
    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Proxy pools route outbound provider traffic through upstream proxies.</div>
        <button class="btn btn-primary" id="btnAddPool">+ Add Pool</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Pool</th><th>Status</th><th>Proxies</th><th>Test</th><th>Updated</th><th></th></tr></thead>
          <tbody id="poolRows"></tbody>
        </table>
      </div>`;
    const rowsEl = container.querySelector('#poolRows');
    const renderRows = () => {
      if (!pools.length) { rowsEl.innerHTML = `<tr><td colspan="6">${UI.empty('🌐', 'No proxy pools')}</td></tr>`; return; }
      rowsEl.innerHTML = pools.map(p => {
        const proxies = Array.isArray(p.data?.proxies) ? p.data.proxies : (Array.isArray(p.data?.urls) ? p.data.urls : []);
        const name = p.data?.name || p.id?.slice(0, 8);
        return `<tr>
          <td><strong>${UI.esc(name)}</strong></td>
          <td>${UI.pill(p.isActive ? 'active' : 'off', p.isActive ? 'active' : 'off')}</td>
          <td>${proxies.length ? `<span class="tag">${proxies.length} proxy${proxies.length > 1 ? 'ies' : 'y'}</span>` : '<span class="muted">—</span>'}</td>
          <td>${p.testStatus ? UI.pill(p.testStatus, p.testStatus) : '<span class="muted">—</span>'}</td>
          <td class="muted">${UI.ts(p.updatedAt)}</td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-sm btn-danger" data-del="${UI.esc(p.id)}">✕</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    };
    renderRows();
    container.querySelector('#btnAddPool').onclick = () => this.editModal();
    rowsEl.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const p = pools.find(x => x.id === del.dataset.del);
        if (p && await UI.confirmDialog({ title: 'Delete pool', message: `Delete pool "${p.data?.name || p.id}"?`, danger: true, okText: 'Delete' })) {
          const r = await API.deletePool(p.id);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); } else UI.toast(r.error || 'Failed', 'error');
        }
      }
    });
  },

  editModal() {
    const { close, bodyEl, footEl } = UI.modal({
      title: 'Add Proxy Pool',
      body: `
        <div class="form-group"><label>Name</label><input class="form-input" id="pp-name" placeholder="main-pool" /></div>
        <div class="form-group"><label>Proxies (one per line — http://user:pass@host:port)</label>
          <textarea class="form-input" id="pp-proxies" style="min-height:120px;font-family:var(--mono)" placeholder="http://user:pass@1.2.3.4:8080"></textarea></div>
        <div class="form-group"><label class="flex-center gap-8" style="cursor:pointer">
          <input type="checkbox" id="pp-active" checked style="width:auto" /> Active</label></div>
      `,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>Create</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const name = bodyEl.querySelector('#pp-name').value.trim();
      const proxies = bodyEl.querySelector('#pp-proxies').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!name) { UI.toast('Name required', 'error'); return; }
      const r = await API.createPool({
        isActive: bodyEl.querySelector('#pp-active').checked ? 1 : 0,
        data: { name, proxies },
      });
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast('Pool created', 'ok');
      close(); APP.refresh();
    };
  },
};
