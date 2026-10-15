// Guards the Discord-only rule: email/password sign-in must be OFF everywhere
// a person actually uses the console, with the single exception of the
// integration harness (NODE_ENV=test). If someone rewrites `=== 'test'` as
// `!== 'production'` — the tempting form that leaves a password form live on
// every developer machine — the near-miss cases below go red instead of
// shipping. See lib/auth-config.mjs for why the exception is keyed on the
// literal string rather than an env var (the ROUTER_ALLOW_DEV_PROVIDERS
// incident in AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailAuthEnabled } from './auth-config.mjs';

test('email auth is enabled only under NODE_ENV=test', () => {
	assert.equal(emailAuthEnabled('test'), true);
});

test('email auth is disabled in production and development', () => {
	assert.equal(emailAuthEnabled('production'), false);
	assert.equal(emailAuthEnabled('development'), false);
});

test('email auth fails closed on missing or empty NODE_ENV', () => {
	assert.equal(emailAuthEnabled(undefined), false);
	assert.equal(emailAuthEnabled(null), false);
	assert.equal(emailAuthEnabled(''), false);
});

test('email auth rejects near-miss NODE_ENV spellings', () => {
	for (const v of ['testing', 'Test', 'TEST', 'test ', ' test', 'staging', 'ci', 'prod']) {
		assert.equal(emailAuthEnabled(v), false, `NODE_ENV=${JSON.stringify(v)} must not enable email auth`);
	}
});
