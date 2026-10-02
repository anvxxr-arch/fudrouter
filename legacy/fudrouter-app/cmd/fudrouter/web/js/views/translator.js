// View: Translator — request/response translation debugger
var View_translator = {
  render(container, d) {
    const stages = [
      { id: 1, label: 'Client Request', desc: 'Raw request from client', icon: '📥' },
      { id: 2, label: 'Source Body', desc: 'After initial conversion', icon: '🔄' },
      { id: 3, label: 'OpenAI Intermediate', desc: 'source → openai format', icon: '🔀' },
      { id: 4, label: 'Target Request', desc: 'openai → target + URL + headers', icon: '📤' },
      { id: 5, label: 'Provider Response', desc: 'Raw SSE from provider', icon: '📨' },
      { id: 6, label: 'OpenAI Response', desc: 'target → openai (response)', icon: '🔁' },
      { id: 7, label: 'Client Response', desc: 'Final response to client', icon: '✅' },
    ];

    container.innerHTML = `
      <div class="toolbar">
        <div class="muted" style="flex:1">Debug request/response translation across protocol boundaries</div>
        <button class="btn" id="btnLoadExample">Load Example</button>
        <button class="btn btn-primary" id="btnRunTranslation">▶ Run Translation</button>
      </div>
      <div class="grid" style="grid-template-columns: 280px 1fr; gap:16px; align-items:start">
        <div class="card">
          <div class="card-title">Pipeline Stages</div>
          <div id="trStages" style="display:flex;flex-direction:column;gap:4px"></div>
        </div>
        <div>
          <div class="card mb-16">
            <div class="card-title">Input — Client Request (OpenAI format)</div>
            <textarea class="form-input" id="trInput" style="min-height:160px;font-family:var(--mono);font-size:.78rem" placeholder='{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'></textarea>
          </div>
          <div class="card">
            <div class="card-title">Stage Output</div>
            <div class="flex-between mb-8">
              <div id="trStageLabel" class="text-2" style="font-weight:600">Select a stage</div>
              <div id="trStageMeta" class="muted" style="font-size:.72rem"></div>
            </div>
            <div class="code-block" id="trOutput" style="min-height:280px;white-space:pre-wrap">Select a pipeline stage to inspect its output.</div>
          </div>
        </div>
      </div>`;

    const stagesEl = container.querySelector('#trStages');
    let activeStage = null;

    const renderStages = () => {
      stagesEl.innerHTML = stages.map(s => `
        <div class="tr-stage" data-stage="${s.id}" style="padding:10px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:10px;border:1px solid transparent;transition:all .2s${activeStage === s.id ? ';background:var(--acc-glow);border-color:rgba(246,130,31,0.3)' : ''}">
          <span style="font-size:1.1rem">${s.icon}</span>
          <div>
            <div style="font-size:.82rem;font-weight:500">${UI.esc(s.label)}</div>
            <div style="font-size:.68rem;color:var(--muted)">${UI.esc(s.desc)}</div>
          </div>
        </div>`).join('');
    };
    renderStages();

    const showStage = (id) => {
      activeStage = id;
      renderStages();
      const stage = stages.find(s => s.id === id);
      const label = container.querySelector('#trStageLabel');
      const meta = container.querySelector('#trStageMeta');
      const output = container.querySelector('#trOutput');
      if (stage) {
        label.textContent = `${stage.icon} ${stage.label}`;
        meta.textContent = stage.desc;
        output.textContent = getStageOutput(id);
      }
    };

    const getStageOutput = (id) => {
      const input = container.querySelector('#trInput').value.trim();
      let parsed;
      try { parsed = JSON.parse(input || '{}'); } catch { parsed = { raw: input }; }
      switch (id) {
        case 1: return JSON.stringify({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: parsed }, null, 2);
        case 2: return JSON.stringify({ model: parsed.model || 'gpt-4o', messages: parsed.messages || [], source_format: 'openai' }, null, 2);
        case 3: return JSON.stringify({ model: parsed.model || 'gpt-4o', messages: parsed.messages || [], target: 'provider_x', intermediate: true }, null, 2);
        case 4: return JSON.stringify({ method: 'POST', url: 'https://api.provider.com/v1/chat/completions', headers: { authorization: 'Bearer ***', 'content-type': 'application/json' }, body: { model: parsed.model, messages: parsed.messages } }, null, 2);
        case 5: return `data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello!"},"index":0}]}\n\ndata: [DONE]`;
        case 6: return `{"id":"chatcmpl-xxx","choices":[{"message":{"role":"assistant","content":"Hello! How can I help?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens=5}}`;
        case 7: return `{"id":"chatcmpl-xxx","choices":[{"message":{"role":"assistant","content":"Hello! How can I help?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`;
        default: return '// no data';
      }
    };

    stagesEl.addEventListener('click', (e) => {
      const stage = e.target.closest('.tr-stage');
      if (stage) showStage(Number(stage.dataset.stage));
    });

    container.querySelector('#btnLoadExample').onclick = () => {
      container.querySelector('#trInput').value = JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello, world!' },
        ],
        max_tokens: 256,
        temperature: 0.7,
      }, null, 2);
      UI.toast('Example loaded', 'info');
    };

    container.querySelector('#btnRunTranslation').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();
      const input = container.querySelector('#trInput').value.trim();
      try {
        const parsed = JSON.parse(input);
        const r = await API.post('/v1/chat/completions', parsed);
        btn.innerHTML = '▶ Run Translation';
        if (r.error) UI.toast(r.error, 'error');
        else { UI.toast('Translation complete — inspect stages', 'ok'); showStage(7); }
      } catch {
        btn.innerHTML = '▶ Run Translation';
        UI.toast('Invalid JSON input', 'error');
      }
    };

    showStage(1);
  },
};
