// fudrouter SPA — UI utilities: modals, toasts, formatters
const UI = (() => {
  // Toast system
  function toast(message, type = 'info', duration = 3500) {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { ok: '✓', error: '✕', warn: '⚠', info: '●' };
    el.innerHTML = `<span>${icons[type] || '●'}</span><span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // Confirmation dialog
  function confirmDialog({ title = 'Confirm', message, okText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px">
          <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close">×</button></div>
          <div class="modal-body"><p class="text-2" style="line-height:1.6">${esc(message)}</p></div>
          <div class="modal-foot">
            <button class="btn" data-cancel>Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const close = () => { overlay.remove(); resolve(false); };
      overlay.querySelector('.modal-close').onclick = close;
      overlay.querySelector('[data-cancel]').onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      overlay.querySelector('[data-ok]').onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  // Generic modal
  function modal({ title, body, footer, maxWidth = '560px' }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:${maxWidth}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close">×</button></div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;
    document.body.appendChild(overlay);
    const bodyEl = overlay.querySelector('.modal-body');
    const footEl = overlay.querySelector('.modal-foot');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else if (footer instanceof Node) footEl.appendChild(footer);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    return { close, bodyEl, footEl, overlay };
  }

  // Prompt dialog
  function promptDialog({ title, label, placeholder = '', value = '', textarea = false, okText = 'OK' }) {
    return new Promise((resolve) => {
      const field = textarea
        ? `<textarea class="form-input" placeholder="${esc(placeholder)}" style="min-height:120px">${esc(value)}</textarea>`
        : `<input class="form-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" />`;
      const { close, bodyEl, footEl } = modal({
        title,
        body: `<div class="form-group"><label>${esc(label)}</label>${field}</div>`,
        footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>${esc(okText)}</button>`,
      });
      const input = bodyEl.querySelector(textarea ? 'textarea' : 'input');
      input.focus();
      footEl.querySelector('[data-c]').onclick = () => { close(); resolve(null); };
      footEl.querySelector('[data-ok]').onclick = () => { const v = input.value.trim(); close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !textarea) { footEl.querySelector('[data-ok]').click(); } });
    });
  }

  // Select dialog
  function selectDialog({ title, label, options, okText = 'OK' }) {
    return new Promise((resolve) => {
      const opts = options.map(o => {
        const val = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : (o.label || o.value);
        return `<option value="${esc(val)}">${esc(label)}</option>`;
      }).join('');
      const { close, bodyEl, footEl } = modal({
        title,
        body: `<div class="form-group"><label>${esc(label)}</label><select class="form-select">${opts}</select></div>`,
        footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-ok>${esc(okText)}</button>`,
      });
      const select = bodyEl.querySelector('select');
      select.focus();
      footEl.querySelector('[data-c]').onclick = () => { close(); resolve(null); };
      footEl.querySelector('[data-ok]').onclick = () => { const v = select.value; close(); resolve(v); };
    });
  }

  // Escape HTML
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Format numbers
  function num(n) {
    if (n === null || n === undefined) return '—';
    if (typeof n !== 'number') n = Number(n);
    if (isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  // Format duration
  function duration(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  // Format timestamp
  function ts(t) {
    if (!t) return '—';
    const d = new Date(t);
    if (isNaN(d)) return t;
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Format full date/time
  function fullTs(t) {
    if (!t) return '—';
    const d = new Date(t);
    if (isNaN(d)) return t;
    return d.toLocaleString();
  }

  // Format bytes
  function bytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  // Format currency
  function currency(n, digits = 4) {
    if (n === null || n === undefined) return '—';
    return '$' + Number(n).toFixed(digits);
  }

  // Truncate string
  function truncate(s, len = 40) {
    if (!s) return '';
    s = String(s);
    return s.length > len ? s.slice(0, len) + '…' : s;
  }

  // Status pill
  function pill(status, text) {
    const s = String(status || '').toLowerCase();
    let cls = 'neutral';
    if (['ok', 'active', 'connected', 'enabled', 'done', 'running', 'true', '1'].includes(s)) cls = 'on';
    else if (['error', 'off', 'inactive', 'disabled', 'false', '0'].includes(s)) cls = 'off';
    else if (['pending', 'warn', 'waiting', 'polling'].includes(s)) cls = 'warn';
    return `<span class="pill ${cls}">${esc(text || status)}</span>`;
  }

  // Loading spinner
  function spin() { return '<span class="spinner"></span>'; }

  // Empty state
  function empty(icon = '📭', text = 'No data') {
    return `<div class="empty-state"><div class="icon">${icon}</div><div>${esc(text)}</div></div>`;
  }

  return {
    toast, confirmDialog, modal, promptDialog, selectDialog,
    esc, num, duration, ts, fullTs, bytes, currency, truncate, pill, spin, empty,
  };
})();
