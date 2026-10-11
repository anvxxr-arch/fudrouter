// Pure input parsers + numeric bounds for the admin console API.
// Extracted verbatim from server/admin.mjs; no app imports, no side effects.
import net from 'node:net';

export const MIN_PRIORITY = 0, MAX_PRIORITY = 10000, MIN_TIMEOUT_MS = 1000, MAX_TIMEOUT_MS = 600000, MAX_BATCH_MODELS = 500, MAX_BULK_TEST = 40, MAX_CHAT_CHARS = 8000;
export const _parseEnum = (allowed, raw) => { const v = String(raw ?? '').trim(); return allowed.includes(v) ? v : null; };
export const _parseInt = (raw, min, max) => { const v = String(raw ?? '').trim(); if (!v || !/^[0-9]+$/.test(v)) return null; const n = Number(v); return (Number.isSafeInteger(n) && n >= min && n <= max) ? n : null; };
export const _parseBool = (raw) => { const v = String(raw ?? '').trim().toLowerCase(); return v === 'on' || v === 'true' || v === '1'; };
export const _cleanField = (raw, max = 200) => { const v = String(raw ?? '').trim(); if (!v || v.length > max) return null; let out = ''; for (const ch of v) { const c = ch.codePointAt(0); if (c === 9 || c === 10 || c === 13 || c >= 32) out += ch; } return out || null; };
export const _parseSlug = (raw) => { const v = String(raw ?? '').trim(); if (!v || v.length > 120) return null; return /^[A-Za-z0-9._:/-]+$/.test(v) ? v : null; };
export const _parseJson = (raw) => { const v = String(raw ?? '').trim(); if (!v) return {}; try { const p = JSON.parse(v); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; } catch { return null; } };
export const _parseFlags = (raw) => { const v = String(raw ?? '').trim(); if (!v) return {}; try { const p = JSON.parse(v); if (!p || typeof p !== 'object' || Array.isArray(p)) return null; const out = {}; for (const [k, x] of Object.entries(p)) { if (typeof x !== 'boolean') return null; out[k] = x; } return out; } catch { return null; } };
export const _parseMicros = (input) => { const s = String(input ?? '').trim(); const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s); if (!m) return null; try { return BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0')); } catch { return null; } };
export const _usdToMicro = (usd) => { const s = String(usd ?? '').trim(); if (!s) return null; const n = Number(s); if (!Number.isFinite(n) || n < 0) return null; return BigInt(Math.round(n * 1000000)).toString(); };
export const _microToUsd = (micro) => { if (micro === null || micro === undefined) return '—'; return (Number(micro) / 1000000).toFixed(2); };
export const _microsToInput = (v) => { const w = v / 1000000n; const f = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, ''); return f ? `${w}.${f}` : w.toString(); };
export const _matchKey = (slug) => String(slug).replace(/^models\//, '');
export const _isIpOrCidr = (value) => { const v = String(value).trim(); if (!v || v.length > 64) return false; const slash = v.indexOf('/'); if (slash === -1) return net.isIP(v) !== 0; if (v.indexOf('/', slash + 1) !== -1) return false; const addr = v.slice(0, slash); const prefix = v.slice(slash + 1); if (!/^(0|[1-9]\d?)$/.test(prefix)) return false; if (net.isIPv4(addr)) return Number(prefix) <= 32; if (net.isIPv6(addr)) return Number(prefix) <= 128; return false; };

// ---- row + value coercers shared by admin.mjs and pages.mjs ----
// admin.mjs had _rowsOf/_num; pages.mjs had rowsOf/num. Both pairs were
// byte-identical in logic, so they are unified here and each file imports
// the name it already used. big/iso/okBody had no admin counterpart.
export const _rowsOf = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []));
export const rowsOf = _rowsOf;
export const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const num = _num;
export const big = (v) => { if (v === null || v === undefined) return 0n; try { return BigInt(String(v)); } catch { return 0n; } };
export const iso = (v) => { if (!v) return null; try { return new Date(v).toISOString(); } catch { return String(v); } };
export const okBody = (req) => { const b = req.body; if (b && typeof b === 'object' && !Array.isArray(b)) return b; return {}; };
