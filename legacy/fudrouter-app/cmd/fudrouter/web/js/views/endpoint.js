// View: Endpoint — endpoint testing
var View_endpoint = {
  render(container, d) {
    const conns = d.connections || [];
    const providers = d.providers || [];

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Test API endpoints and connections directly</div>
        <select class="form-select" id="epConn" style="max-width:240px">
          <option value="">— select connection —</option>
          ${conns.map(c => `<option value="${UI.esc(c.id)}">${UI.esc(c.name)} (${UI.esc(c.provider)})</option>`).join('')}
        </select>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 1fr; gap:16px; align-items:start">
        <div>
          <div class="card mb-16">
            <div class="card-title">Request</div>
            <div class="form-group"><label>Method</label>
              <select class="form-select" id="epMethod">
                <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
              </select></div>
            <div class="form-group"><label>Endpoint Path</label>
              <input class="form-input" id="epPath" value="/v1/models" placeholder="/v1/models" /></div>
            <div class="form-group"><label>Headers (JSON, optional)</label>
              <textarea class="form-input" id="epHeaders" style="min-height:80px;font-family:var(--mono);font-size:.78rem" placeholder='{"Authorization":"Bearer sk-…"}'></textarea></div>
            <div class="form-group"><label>Body (JSON, optional)</label>
              <textarea class="form-input" id="epBody" style="min-height:120px;font-family:var(--mono);font-size:.78rem" placeholder='{"model":"gpt-4o","messages":[]}'></textarea></div>
            <button class="btn btn-primary" id="epSend" style="width:100%">▶ Send Request</button>
          </div>
          <div class="card">
            <div class="card-title">Quick Tests</div>
            <div class="btn-group" style="flex-direction:column;align-items:stretch">
              <button class="btn ep-quick" data-q="health">GET /api/health</button>
              <button class="btn ep-quick" data-q="models">GET /v1/models</button>
              <button class="btn ep-quick" data-q="settings">GET /api/settings</button>
              <button class="btn ep-quick" data-q="usage">GET /api/usage/stats</button>
              <button class="btn ep-quick" data-q="providers">GET /api/providers</button>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-title">Response</div>
            <div class="flex-between mb-8">
              <div id="epStatus" class="muted" style="font-size:.78rem">—</div>
              <div id="epTime" class="muted" style="font-size:.72rem"></div>
            </div>
            <div class="code-block" id="epResponse" style="min-height:400px;white-space:pre-wrap">Send a request to see the response.</div>
          </div>
        </div>
      </div>`;

    const responseEl = container.querySelector('#epResponse');
    const statusEl = container.querySelector('#epStatus');
    const timeEl = container.querySelector('#epTime');

    const sendRequest = async (method, path, headers, body) => {
      const t0 = performance.now();
      statusEl.textContent = 'requesting…';
      responseEl.innerHTML = UI.spin();
      try {
        const opts = { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
        if (headers) { try { Object.assign(opts.headers, JSON.parse(headers)); } catch {} }
        if (body && method !== 'GET') opts.body = body;
        const res = await fetch(path, opts);
        const text = await res.text();
        const elapsed = Math.round(performance.now() - t0);
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        statusEl.innerHTML = `${UI.pill(res.ok ? 'active' : 'off', `HTTP ${res.status}`)}`;
        timeEl.textContent = `${elapsed}ms · ${UI.bytes(text.length)}`;
        responseEl.textContent = json ? JSON.stringify(json, null, 2) : text;
      } catch (e) {
        statusEl.innerHTML = UI.pill('off', 'error');
        timeEl.textContent = `${Math.round(performance.now() - t0)}ms`;
        responseEl.textContent = `Error: ${e.message}`;
      }
    };

    container.querySelector('#epSend').onclick = () => {
      const method = container.querySelector('#epMethod').value;
      const path = container.querySelector('#epPath').value.trim();
      const headers = container.querySelector('#epHeaders').value.trim();
      const body = container.querySelector('#epBody').value.trim();
      if (!path) { UI.toast('Path required', 'error'); return; }
      sendRequest(method, path, headers, body);
    };

    container.querySelectorAll('.ep-quick').forEach(btn => {
      btn.onclick = () => {
        const q = btn.dataset.q;
        const map = {
          health: ['GET', '/api/health', '', ''],
          models: ['GET', '/v1/models', '', ''],
          settings: ['GET', '/api/settings', '', ''],
          usage: ['GET', '/api/usage/stats', '', ''],
          providers: ['GET', '/api/providers', '', ''],
        };
        const [m, p, h, b] = map[q] || ['GET', '/', '', ''];
        container.querySelector('#epMethod').value = m;
        container.querySelector('#epPath').value = p;
        container.querySelector('#epHeaders').value = h;
        container.querySelector('#epBody').value = b;
        sendRequest(m, p, h, b);
      };
    });
  },
};
