// View: Chat Tester — model selector + streaming conversation
var View_chat = {
  messages: [],

  render(container, d) {
    const models = (d.modelsAvailability || []).map(m => m.id).filter(Boolean);
    const preset = sessionStorage.getItem('fudrouter_chat_model') || '';
    if (preset) sessionStorage.removeItem('fudrouter_chat_model');

    container.innerHTML = `
      <div class="grid" style="grid-template-columns: 1fr 300px; gap:16px; align-items:start">
        <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:420px">
          <div class="flex-between mb-16">
            <div class="flex-center gap-8">
              <select class="form-select" id="chat-model" style="max-width:320px">
                <option value="">— select model —</option>
                ${models.map(m => `<option value="${UI.esc(m)}" ${m === preset ? 'selected' : ''}>${UI.esc(m)}</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-sm" id="chat-clear">Clear</button>
          </div>
          <div id="chat-log" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:4px 2px"></div>
          <div class="mt-16">
            <div class="flex-center gap-8">
              <input class="form-input" id="chat-input" placeholder="Type a message… (Enter to send)" style="flex:1" autocomplete="off" />
              <button class="btn btn-primary" id="chat-send">Send</button>
            </div>
          </div>
        </div>
        <div>
          <div class="card mb-16">
            <div class="card-title">Connection</div>
            <div id="chat-meta" class="muted" style="font-size:.78rem;line-height:1.8">—</div>
          </div>
          <div class="card">
            <div class="card-title">Tips</div>
            <div class="muted" style="font-size:.78rem;line-height:1.8">
              · Model format: <code>provider/model</code><br>
              · Routes via fallback strategy<br>
              · Response headers show the winning connection<br>
              · Check Usage page for request log
            </div>
          </div>
        </div>
      </div>`;

    const log = container.querySelector('#chat-log');
    const input = container.querySelector('#chat-input');
    const send = container.querySelector('#chat-send');
    const modelSel = container.querySelector('#chat-model');
    const meta = container.querySelector('#chat-meta');

    const renderMsgs = () => {
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
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: this.messages.filter(m => m.content !== '…').map(m => ({ role: m.role, content: m.content })),
          }),
        });
        const elapsed = Math.round(performance.now() - t0);
        const raw = await res.text();
        let content = raw, metaStr = `HTTP ${res.status} · ${elapsed}ms`;
        try {
          const j = JSON.parse(raw);
          content = j.choices?.[0]?.message?.content || j.error?.message || raw;
          if (j.usage) metaStr += ` · ${j.usage.prompt_tokens || 0}p/${j.usage.completion_tokens || 0}c tok`;
        } catch {}
        const connHdr = res.headers.get('X-Nprouter-Connection');
        if (connHdr) metaStr += ` · ${connHdr.slice(0, 8)}`;
        this.messages[asstIdx] = { role: 'assistant', content, meta: metaStr };
        meta.textContent = `${model} · ${metaStr}`;
        if (!res.ok) UI.toast(`Request failed: HTTP ${res.status}`, 'error');
      } catch (e) {
        this.messages[asstIdx] = { role: 'assistant', content: 'Error: ' + e.message, meta: 'network error' };
      }
      renderMsgs();
    };

    send.onclick = doSend;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    container.querySelector('#chat-clear').onclick = () => { this.messages = []; renderMsgs(); meta.textContent = '—'; };
    input.focus();
  },
};
