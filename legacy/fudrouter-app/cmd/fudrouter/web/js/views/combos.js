// View: Combos — routing rules
var View_combos = {
  render(container, d) {
    const combos = d.combos || [];
    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Combos define ordered model failover groups — first healthy model wins.</div>
        <button class="btn btn-primary" id="btnAddCombo">+ Add Combo</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Models</th><th>Updated</th><th></th></tr></thead>
          <tbody id="comboRows"></tbody>
        </table>
      </div>`;
    const rowsEl = container.querySelector('#comboRows');
    const renderRows = () => {
      if (!combos.length) { rowsEl.innerHTML = `<tr><td colspan="5">${UI.empty('🔀', 'No combos defined')}</td></tr>`; return; }
      rowsEl.innerHTML = combos.map(c => {
        const models = Array.isArray(c.models) ? c.models : [];
        return `<tr>
          <td><strong>${UI.esc(c.name)}</strong></td>
          <td>${c.kind ? `<span class="tag">${UI.esc(c.kind)}</span>` : '<span class="muted">—</span>'}</td>
          <td>${models.length ? models.map(m => `<span class="tag" style="margin:1px">${UI.esc(typeof m === 'string' ? m : (m.model || m.id || JSON.stringify(m)))}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
          <td class="muted">${UI.ts(c.updatedAt)}</td>
          <td class="text-right">
            <div class="btn-group" style="justify-content:flex-end">
              <button class="btn btn-sm" data-edit="${UI.esc(c.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-del="${UI.esc(c.id)}">✕</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    };
    renderRows();
    container.querySelector('#btnAddCombo').onclick = () => this.editModal(null, combos);
    rowsEl.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (edit) { const c = combos.find(x => x.id === edit.dataset.edit); if (c) this.editModal(c, combos); }
      if (del) {
        const c = combos.find(x => x.id === del.dataset.del);
        if (c && await UI.confirmDialog({ title: 'Delete combo', message: `Delete "${c.name}"?`, danger: true, okText: 'Delete' })) {
          const r = await API.deleteCombo(c.id);
          if (r.ok) { UI.toast('Deleted', 'ok'); APP.refresh(); } else UI.toast(r.error || 'Failed', 'error');
        }
      }
    });
  },

  editModal(combo) {
    const isNew = !combo;
    const c = combo || { name: '', kind: 'fallback', models: [] };
    const modelsStr = (c.models || []).map(m => typeof m === 'string' ? m : (m.model || m.id || '')).filter(Boolean).join('\n');
    const { close, bodyEl, footEl } = UI.modal({
      title: isNew ? 'Add Combo' : `Edit — ${c.name}`,
      body: `
        <div class="form-row">
          <div class="form-group"><label>Name</label><input class="form-input" id="cb-name" value="${UI.esc(c.name)}" placeholder="code-fast" /></div>
          <div class="form-group"><label>Kind</label>
            <select class="form-select" id="cb-kind">
              ${['fallback', 'round-robin', 'race'].map(k => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group"><label>Models (one per line, ordered by priority)</label>
          <textarea class="form-input" id="cb-models" style="min-height:140px;font-family:var(--mono)" placeholder="openai/gpt-4o&#10;anthropic/claude-sonnet-4">${UI.esc(modelsStr)}</textarea></div>
      `,
      footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>${isNew ? 'Create' : 'Save'}</button>`,
    });
    footEl.querySelector('[data-c]').onclick = close;
    footEl.querySelector('[data-ok]').onclick = async () => {
      const body = {
        name: bodyEl.querySelector('#cb-name').value.trim(),
        kind: bodyEl.querySelector('#cb-kind').value,
        models: bodyEl.querySelector('#cb-models').value.split('\n').map(s => s.trim()).filter(Boolean),
      };
      if (!body.name) { UI.toast('Name required', 'error'); return; }
      const r = isNew ? await API.createCombo(body) : await API.updateCombo(combo.id, body);
      if (r.error) { UI.toast(r.error, 'error'); return; }
      UI.toast(isNew ? 'Combo created' : 'Saved', 'ok');
      close(); APP.refresh();
    };
  },
};
