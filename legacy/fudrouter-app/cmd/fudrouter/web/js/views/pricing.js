// View: Pricing — pricing/cost management
var View_pricing = {
  render(container, d) {
    const pricing = d.pricing || {};
    const usage = d.usage || {};

    const providers = Object.keys(pricing).sort();
    const totalModels = providers.reduce((sum, p) => sum + Object.keys(pricing[p] || {}).length, 0);

    const costTypes = ['input', 'output', 'cached', 'reasoning', 'cache_creation'];

    const renderProviderSection = (provider) => {
      const models = pricing[provider];
      if (!models) return '';
      const modelNames = Object.keys(models).sort();

      return `<div class="card mb-16">
        <div class="card-title">${UI.esc(provider.toUpperCase())} <span class="muted font-normal" style="font-size:.85rem">(${modelNames.length} models)</span></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                ${costTypes.map(ct => `<th class="text-right">${UI.esc(ct)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${modelNames.map(model => `
                <tr>
                  <td><code>${UI.esc(model)}</code></td>
                  ${costTypes.map(ct => `
                    <td class="text-right">
                      <input type="number" step="0.01" min="0"
                        value="${UI.esc(models[model][ct] || 0)}"
                        data-provider="${UI.esc(provider)}"
                        data-model="${UI.esc(model)}"
                        data-type="${UI.esc(ct)}"
                        class="pricing-input"
                        style="width:80px;text-align:right;padding:2px 6px" />
                    </td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    };

    const totalCost = usage.totalCost || 0;
    const totalRequests = usage.totalRequests || 0;
    const totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);

    container.innerHTML = `
      <div class="grid grid-3 mb-16">
        <div class="card stat-card">
          <div class="value">${UI.num(totalModels)}</div>
          <div class="label">Models</div>
        </div>
        <div class="card stat-card">
          <div class="value">${providers.length}</div>
          <div class="label">Providers</div>
        </div>
        <div class="card stat-card">
          <div class="value">${UI.currency(totalCost)}</div>
          <div class="label">Total Cost</div>
        </div>
      </div>

      <div class="card mb-16">
        <div class="card-title">How Pricing Works</div>
        <div class="text-2" style="line-height:1.6;font-size:.82rem">
          <p>Costs are calculated based on token usage and pricing rates. Each request's cost is determined by:</p>
          <ul style="margin:8px 0 8px 24px;list-style:disc">
            <li><strong>Input:</strong> Standard prompt tokens × input rate</li>
            <li><strong>Output:</strong> Completion/response tokens × output rate</li>
            <li><strong>Cached:</strong> Cached input tokens × cached rate</li>
            <li><strong>Reasoning:</strong> Reasoning/thinking tokens × reasoning rate (falls back to output rate)</li>
            <li><strong>Cache Creation:</strong> Tokens for cache creation × cache_creation rate (falls back to input rate)</li>
          </ul>
          <p>All rates are in <strong>dollars per million tokens</strong> ($/1M tokens). Example: An input rate of 2.50 means $2.50 per 1,000,000 input tokens.</p>
        </div>
      </div>

      <div class="toolbar">
        <div class="muted" style="flex:1">Pricing rates per million tokens ($/1M)</div>
        <button class="btn btn-primary" id="btnSavePricing">💾 Save Changes</button>
        <button class="btn" id="btnResetDefaults">↺ Reset to Defaults</button>
      </div>

      <div id="pricingSections">
        ${providers.length > 0
          ? providers.map(p => renderProviderSection(p)).join('')
          : UI.empty('💰', 'No pricing data available. Configure rates below to enable cost tracking.')}
      </div>

      <!-- Edit Modal -->
      <div id="pricingModal"></div>
    `;

    // Event handlers
    container.querySelector('#btnSavePricing').onclick = async (e) => {
      const btn = e.currentTarget; btn.innerHTML = UI.spin();

      // Collect all pricing changes
      const newPricing = {};
      container.querySelectorAll('.pricing-input').forEach(input => {
        const provider = input.dataset.provider;
        const model = input.dataset.model;
        const type = input.dataset.type;
        const value = parseFloat(input.value) || 0;
        if (!newPricing[provider]) newPricing[provider] = {};
        if (!newPricing[provider][model]) newPricing[provider][model] = {};
        newPricing[provider][model][type] = value;
      });

      try {
        const r = await API.patch('/api/pricing', newPricing);
        if (r.error) { UI.toast(r.error, 'error'); }
        else { UI.toast('Pricing saved ✓', 'ok'); APP.refresh(); }
      } catch (err) {
        UI.toast('Failed to save pricing: ' + err.message, 'error');
      }
      btn.textContent = '💾 Save Changes';
    };

    container.querySelector('#btnResetDefaults').onclick = async () => {
      if (!await UI.confirmDialog({ title: 'Reset pricing', message: 'Reset all pricing to default rates? This cannot be undone.', danger: true, okText: 'Reset' })) return;
      try {
        const r = await API.del('/api/pricing');
        if (r.ok) { UI.toast('Pricing reset to defaults', 'ok'); APP.refresh(); }
        else UI.toast(r.error || 'Reset failed', 'error');
      } catch (err) {
        UI.toast('Failed to reset: ' + err.message, 'error');
      }
    };
  },
};
