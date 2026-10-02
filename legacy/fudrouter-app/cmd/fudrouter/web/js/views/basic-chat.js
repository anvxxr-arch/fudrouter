// View: Basic Chat — basic chat tester (simplified, no streaming)
var View_basicchat = {
  messages: [],

  render(container, d) {
    const models = (d.modelsAvailability || []).map(m => m.id).filter(Boolean);
    const conns = d.connections || [];

    container.innerHTML = `
      <div class="grid" style="grid-template-columns: 1fr 280px; gap:16px; align-items:start">
        <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:420px">
          <div class="flex-between mb-16">
            <div class="flex-center gap-8">
              <select class="form-select" id="bc-model" style="max-width:280px">
                <option value="">— select model —</option>
                ${models.map(m => `<option value="${UI.esc(m)}">${UI.esc(m)}</option>`).join('')}
              </select>
              <select class="form-select" id="bc-conn" style="max-width:180px">
                <option value="">auto route</option>
                ${conns.map(c => `<option value="${UI.esc(c.id)}">${UI.esc(c.name)}</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-sm" id="bc-clear">Clear</button>
          </div>
          <div id="bc-log" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 2px"></div>
          <div class="mt-16">
            <div class="flex-center gap-8">
              <input class="form-input" id="bc-input" placeholder="Type a message… (Enter to send)" style="flex:1" autocomplete="off" />
              <button class="btn btn-primary" id="bc-send">Send</button>
            </div>
          </div>
        </div>
        <div>
          <div class="card mb-16">
            <div class="card-title">Settings</div>
            <div class="form-group"><label>Temperature</label>
              <input class="form-input" id="bc-temp" type="number" value="0.7" min="0" max="2" step="0.1" /></div>
            <div class="form-group"><label>Max Tokens</label>
              <input class="form-input" id="bc-maxtok" type="number" value="1024" min="1" max="128000" /></div>
          </div>
          <div class="card">
            <div class="card-title">Info</div>
            <div class="muted" style="font-size:.78rem;line-height:1.8">
              · Non-streaming chat tester<br>
              · Routes via fallback strategy<br>
              · Select a connection to pin<br>
              · Check Usage for history
            </div>
          </div>
        </div>
      </div>`;

    const log = container.querySelector('#bc-log');
    const input = container.querySelector('#bc-input');
    const send = container.querySelector('#bc-send');
    const modelSel = container.querySelector('#bc-model');
    const connSel = container.querySelector('#bc-conn');

    const renderMsgs = () => {
      if (!this.messages.length) {
        log.innerHTML = `<div class="empty-state"><div class="icon">💬</div><div>Start a conversation</div></div>`;
        return;
      }
      log.innerHTML = this.messages.map(m => `
        <div style="display:flex;justify-content:${m.role === 'user' ? 'flex-end' : 'flex-start'}">
          <div style="max-width:80%;padding:10px 14px;border-radius:12px;background:${m.role === 'user' ? 'var(--acc-glow)' : 'var(--card-2)'};border:1px solid ${m.role === 'user' ? 'rgba(246,130,31,0.3)' : 'var(--line)'}">
            <div style="font-size:.68rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">${m.role}${m.meta ? ` · ${UI.esc(m.meta)}` : ''}</div>
            <div style="font-size:.85rem;white-space:pre-wrap;line-height:1.6">${UI.esc(m.content)}</div>
          </div>
        </div>`).join('');
      log.scrollTop = log.scrollHeight;
    };
    renderMsgs();

    const doSend = async () => {
      const text = input.value.trim();
      const model = modelSel.value;
      if (!text) return;
      if (!model) { UI.toast('Select a model first', 'warn'); return; }
      input.value = '';
      this.messages.push({ role: 'user', content: text });
      renderMsgs();
      const asstIdx = this.messages.length;
      this.messages.push({ role: 'assistant', content: '…' });
      renderMsgs();

      const t0 = performance.now();
      try {
        const body = {
          model,
          messages: this.messages.filter(m => m.content !== '…').map(m => ({ role: m.role, content: m.content })),
          temperature: Number(container.querySelector('#bc-temp').value) || 0.7,
          max_tokens: Number(container.querySelector('#bc-maxtok').value) || 1024,
        };
        const connId = connSel.value;
        const path = connId ? `/api/connections/${connId}/test` : '/v1/chat/completions';
        const res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const elapsed = Math.round(performance.now() - t0);
        const raw = await res.text();
        let content = raw, metaStr = `HTTP ${res.status} · ${elapsed}ms`;
        try {
          const j = JSON.parse(raw);
          content = j.choices?.[0]?.message?.content || j.error?.message || raw;
          if (j.usage) metaStr += ` · ${j.usage.prompt_tokens || 0}p/${j.usage.completion_tokens || 0}c`;
        } catch {}
        this.messages[asstIdx] = { role: 'assistant', content, meta: metaStr };
        if (!res.ok) UI.toast(`Request failed: HTTP ${res.status}`, 'error');
      } catch (e) {
        this.messages[asstIdx] = { role: 'assistant', content: 'Error: ' + e.message, meta: 'network error' };
      }
      renderMsgs();
    };

    send.onclick = doSend;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    container.querySelector('#bc-clear').onclick = () => { this.messages = []; renderMsgs(); };
    input.focus();
  },
};
