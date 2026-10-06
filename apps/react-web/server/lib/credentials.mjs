// Credential master-key handling + AES-256-GCM sealing for provider secrets.
// Extracted verbatim from server/admin.mjs; needs node:crypto only.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function _masterKey() { const k = process.env.CREDENTIALS_MASTER_KEY; if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set'); const buf = Buffer.from(k, 'base64'); if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes'); return buf; }
export const _encCred = (plain) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', _masterKey(), iv); const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]); return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64'); };
export const _decCred = (enc) => { const buf = Buffer.from(enc, 'base64'); if (buf.length < 28) throw new Error('ciphertext too short'); const iv = buf.subarray(0, 12); const tag = buf.subarray(buf.length - 16); const ct = buf.subarray(12, buf.length - 16); const d = createDecipheriv('aes-256-gcm', _masterKey(), iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')); };
export const _tokenAt = (cred, i) => { const accts = Array.isArray(cred.accounts) ? cred.accounts : []; const a = accts[i]; return String(a?.access_token || a?.api_key || cred.access_token || cred.api_key || ''); };
export const _headersFor = (cred, token) => { const h = { ...((cred.default_headers ?? {})) }; if (token) h.authorization = `Bearer ${token}`; return h; };
