#!/usr/bin/env node
/**
 * ops/verify-gemini.mjs — live proof of the /v1beta surface (gemini.go).
 *
 * A real Gemini SDK asks for exactly these five things, so this script does
 * them against the running router with a throwaway key minted straight into
 * the DB and revoked on exit:
 *
 *   GET  /v1beta/models                                     catalogue
 *   GET  /v1beta/models/{model}                             one model
 *   POST /v1beta/models/{model}:generateContent             buffered
 *   POST /v1beta/models/{model}:streamGenerateContent       SSE (data: chunks)
 *   POST /v1beta/models/{model}:countTokens                 estimate
 *
 * plus the negative cases that decide whether an SDK fails loudly and
 * correctly: no key (401 in the Google envelope), unknown model (404), and a
 * malformed body (400).
 *
 * Usage: node ops/verify-gemini.mjs [model-slug]
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
const apiKey = `sk-ar-${prefix}_${secret}`;
psql(`insert into api_key (id, user_id, name, prefix, key_hash, status) values ('${keyId}', '${USER_ID}', 'fox-gemini-verify', '${prefix}', '${createHash('sha256').update(secret).digest('hex')}', 'active');`);
const cleanup = () => {
	try { psql(`update api_key set status='revoked', revoked_at=now() where id='${keyId}';`); console.log('\n[cleanup] temp key revoked'); }
	catch (e) { console.error('[cleanup] failed:', e.message); }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
};
const call = (path, body) => fetch(`${ROUTER}${path}`, {
	method: body ? 'POST' : 'GET',
	headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
	body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));

// ---- 1. catalogue ---------------------------------------------------------
const list = await call('/v1beta/models');
let models = [];
try { models = JSON.parse(list.text).models ?? []; } catch { /* bad json */ }
check('GET /v1beta/models', list.status === 200 && models.length > 0, `${list.status}, ${models.length} models, first=${models[0]?.name ?? '-'}`);
check('model names use models/{slug}', models.every((m) => typeof m.name === 'string' && m.name.startsWith('models/')));

const one = await call(`/v1beta/models/${MODEL}`);
let oneObj = {};
try { oneObj = JSON.parse(one.text); } catch { /* bad json */ }
check('GET /v1beta/models/{model}', one.status === 200 && oneObj.name === `models/${MODEL}`, `${one.status} ${oneObj.name ?? one.text.slice(0, 100)}`);
check('supportedGenerationMethods listed', Array.isArray(oneObj.supportedGenerationMethods) && oneObj.supportedGenerationMethods.includes('generateContent'));

// ---- 2. generateContent ---------------------------------------------------
const gen = await call(`/v1beta/models/${MODEL}:generateContent`, {
	contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
	generationConfig: { maxOutputTokens: 40, temperature: 0 },
});
let genObj = {};
try { genObj = JSON.parse(gen.text); } catch { /* bad json */ }
const genText = (genObj.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
check('POST :generateContent', gen.status === 200 && !!genObj.candidates, `${gen.status} ${gen.text.slice(0, 120)}`);
check('answer in candidates[0].content.parts[].text', genText.length > 0, JSON.stringify(genText.slice(0, 80)));
check('content role is "model"', genObj.candidates?.[0]?.content?.role === 'model');
check('usageMetadata present', typeof genObj.usageMetadata?.totalTokenCount === 'number', JSON.stringify(genObj.usageMetadata));
check('finishReason is a Gemini enum', ['STOP', 'MAX_TOKENS', 'SAFETY', '', undefined].includes(genObj.candidates?.[0]?.finishReason), String(genObj.candidates?.[0]?.finishReason));

// ---- 3. streamGenerateContent --------------------------------------------
const stream = await fetch(`${ROUTER}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
	method: 'POST',
	headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
	body: JSON.stringify({
		contents: [{ role: 'user', parts: [{ text: 'Count from one to five, comma separated.' }] }],
		generationConfig: { maxOutputTokens: 60, temperature: 0 },
	}),
});
const sseRaw = await stream.text();
const events = sseRaw.split('\n\n').map((b) => b.trim()).filter(Boolean);
const dataLines = events.filter((e) => e.startsWith('data: '));
let streamedText = '';
let sawFinal = false;
let streamUsage = null;
for (const e of dataLines) {
	const payload = e.slice(6);
	if (payload === '[DONE]') continue;
	let obj;
	try { obj = JSON.parse(payload); } catch { continue; }
	streamedText += (obj.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
	if (obj.usageMetadata) { sawFinal = true; streamUsage = obj.usageMetadata; }
}
check('stream returns SSE events', dataLines.length > 0, `${dataLines.length} data lines`);
check('stream text accumulates', streamedText.trim().length > 0, JSON.stringify(streamedText.slice(0, 80)));
check('stream carries usageMetadata on a final chunk', sawFinal, JSON.stringify(streamUsage));

// ---- 4. countTokens -------------------------------------------------------
const ct = await call(`/v1beta/models/${MODEL}:countTokens`, {
	contents: [{ role: 'user', parts: [{ text: 'how many tokens is this sentence exactly' }] }],
});
let ctObj = {};
try { ctObj = JSON.parse(ct.text); } catch { /* bad json */ }
check('POST :countTokens', ct.status === 200 && typeof ctObj.totalTokens === 'number' && ctObj.totalTokens > 0, `${ct.status} ${JSON.stringify(ctObj)}`);

// ---- 5. negative cases ----------------------------------------------------
const noKey = await fetch(`${ROUTER}/v1beta/models/${MODEL}:generateContent`, {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
let noKeyObj = {};
try { noKeyObj = JSON.parse(noKey.text); } catch { /* bad json */ }
check('missing key -> 401 Google envelope', noKey.status === 401 && noKeyObj.error?.status === 'UNAUTHENTICATED', `${noKey.status} ${noKey.text.slice(0, 100)}`);

const badModel = await call('/v1beta/models/definitely-not-a-model:generateContent', {
	contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
});
let badObj = {};
try { badObj = JSON.parse(badModel.text); } catch { /* bad json */ }
check('unknown model -> 404 NOT_FOUND', badModel.status === 404 && badObj.error?.status === 'NOT_FOUND', `${badModel.status} ${badModel.text.slice(0, 120)}`);

const badBody = await call(`/v1beta/models/${MODEL}:generateContent`, { contents: [] });
let badBodyObj = {};
try { badBodyObj = JSON.parse(badBody.text); } catch { /* bad json */ }
check('empty contents -> 400 INVALID_ARGUMENT', badBody.status === 400 && badBodyObj.error?.status === 'INVALID_ARGUMENT', `${badBody.status} ${badBody.text.slice(0, 120)}`);

const missingModel = await call('/v1beta/models/:generateContent', { contents: [{ role: 'user', parts: [{ text: 'x' }] }] });
check('missing model segment -> 400', missingModel.status === 400, `${missingModel.status}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
