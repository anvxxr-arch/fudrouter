#!/usr/bin/env node
/**
 * ops/verify-anthropic.mjs — live smoke for the /v1/messages surface.
 *
 * The `begin` signature changed from a bool to a wire name so /v1beta could
 * reuse it; this proves /v1/messages still accepts a request AND still answers
 * rejections in the Anthropic envelope.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROUTER = process.env.ROUTER_BASE || 'http://127.0.0.1:8100';
const USER_ID = process.env.VERIFY_USER_ID || 'usr_01a0f3f5-af5a-72a6-b8ae-3483d21a0ba3';
const MODEL = process.argv[2] || 'deepseek-v4.1-flash';
const psql = (q) => execFileSync('docker', ['exec', 'postgre', 'psql', '-U', 'postgres', '-d', 'fudrouter', '-tAc', q], { encoding: 'utf8' }).trim();

const keyId = `key_${randomBytes(8).toString('hex')}`;
let prefix;
do { prefix = randomBytes(6).toString('base64url'); } while (prefix.includes('_'));
const secret = randomBytes(32).toString('base64url');
const key = `sk-ar-${prefix}_${secret}`;
psql(`insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}','${USER_ID}','fox-anthropic-verify','${prefix}','${createHash('sha256').update(secret).digest('hex')}','active');`);
process.on('exit', () => { try { psql(`update api_key set status='revoked', revoked_at=now() where id='${keyId}';`); console.log('[cleanup] temp key revoked'); } catch {} });

let failures = 0;
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); if (!ok) failures++; };

const ok = await fetch(`${ROUTER}/v1/messages`, {
	method: 'POST',
	headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
	body: JSON.stringify({ model: MODEL, max_tokens: 40, messages: [{ role: 'user', content: 'Reply with one word.' }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
let body = {};
try { body = JSON.parse(ok.text); } catch {}
check('/v1/messages buffered', ok.status === 200 && Array.isArray(body.content), `${ok.status} ${ok.text.slice(0, 120)}`);
check('Anthropic answer shape (type=message, role=assistant)', body.type === 'message' && body.role === 'assistant', `type=${body.type} role=${body.role}`);

const noKey = await fetch(`${ROUTER}/v1/messages`, {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
let errBody = {};
try { errBody = JSON.parse(noKey.text); } catch {}
check('rejection is the Anthropic envelope', noKey.status === 401 && errBody.type === 'error' && !!errBody.error?.type, `${noKey.status} ${noKey.text.slice(0, 120)}`);

const stream = await fetch(`${ROUTER}/v1/messages`, {
	method: 'POST',
	headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
	body: JSON.stringify({ model: MODEL, max_tokens: 30, stream: true, messages: [{ role: 'user', content: 'Say hi.' }] }),
});
const raw = await stream.text();
const events = [...raw.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
check('/v1/messages stream emits Anthropic events', events.includes('message_start') && events.includes('content_block_delta'), events.slice(0, 6).join(','));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
