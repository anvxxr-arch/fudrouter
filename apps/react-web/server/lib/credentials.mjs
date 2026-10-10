// Credential master-key handling + AES-256-GCM sealing for provider secrets.
// Extracted verbatim from server/admin.mjs; needs node:crypto only.
//
// The CANONICAL envelope is packages/platform/server/credentials.ts, reached
// from the server through server/lib/platform-ts.mjs: that is what admin.mjs
// imports, and that is what the workers and the scheduler decrypt with. This
// module is still the home of _tokenAt/_headersFor, which ssrf.mjs imports.
// Keep the envelope here in sync with the shared module (rotation seam
// included) so the two never disagree — but fix behavior THERE first.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function _masterKey() { const k = process.env.CREDENTIALS_MASTER_KEY; if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set'); const buf = Buffer.from(k, 'base64'); if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes'); return buf; }
// Previous master key during a rotation window (CREDENTIALS_MASTER_KEY_PREV).
// Null outside a rotation — the steady state, not an error. A malformed prev
// throws loudly: silently ignoring it would make old rows undecryptable.
export function _masterKeyPrev() { const k = process.env.CREDENTIALS_MASTER_KEY_PREV; if (!k) return null; const buf = Buffer.from(k, 'base64'); if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY_PREV must be base64 of 32 bytes'); return buf; }
export const _encCred = (plain) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', _masterKey(), iv); const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]); return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64'); };
const _decryptWith = (enc, key) => { const buf = Buffer.from(enc, 'base64'); if (buf.length < 28) throw new Error('ciphertext too short'); const iv = buf.subarray(0, 12); const tag = buf.subarray(buf.length - 16); const ct = buf.subarray(12, buf.length - 16); const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')); };
// Decrypt tries the active key first, then the previous one during a rotation
// window. Encrypt always uses the active key.
export const _decCred = (enc) => { const active = _masterKey(); try { return _decryptWith(enc, active); } catch (e) { const prev = _masterKeyPrev(); if (!prev) throw e; return _decryptWith(enc, prev); } };
export const _tokenAt = (cred, i) => { const accts = Array.isArray(cred.accounts) ? cred.accounts : []; const a = accts[i]; return String(a?.access_token || a?.api_key || cred.access_token || cred.api_key || ''); };
export const _headersFor = (cred, token) => { const h = { ...((cred.default_headers ?? {})) }; if (token) h.authorization = `Bearer ${token}`; return h; };
