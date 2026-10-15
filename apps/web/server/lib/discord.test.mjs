// Pins the Discord guild-join request shape without touching the network.
// `joinFudcourt` calls the live Discord API, so no test can cover the PUT
// itself without a bot token — but a silent change to the URL, method, or
// auth header would break every post-login join with no signal. This file
// intercepts `fetch` and asserts the request is exactly what Discord expects:
// PUT to /guilds/{guild}/members/{user} with `Bot <token>` auth. If any of
// those drift, this goes red instead of shipping a broken join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinFudcourt, FUDCOURT_GUILD_ID } from './discord.mjs';

test('joinFudcourt PUTs the member endpoint with Bot auth', async () => {
	const calls = [];
	const orig = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		return { status: 201 };
	};
	try {
		const status = await joinFudcourt('123456789012345678', 'test-token');
		assert.equal(status, 201);
		assert.equal(calls.length, 1);
		const { url, opts } = calls[0];
		assert.equal(url, `https://discord.com/api/v10/guilds/${FUDCOURT_GUILD_ID}/members/123456789012345678`);
		assert.equal(opts.method, 'PUT');
		assert.equal(opts.headers.authorization, 'Bot test-token');
		assert.equal(opts.headers['content-type'], 'application/json');
	} finally {
		globalThis.fetch = orig;
	}
});

test('joinFudcourt returns 204 passthrough for existing members', async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => ({ status: 204 });
	try {
		assert.equal(await joinFudcourt('123456789012345678', 'test-token'), 204);
	} finally {
		globalThis.fetch = orig;
	}
});

test('joinFudcourt returns null without a token or with a bad id', async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error('fetch must not be called'); };
	try {
		assert.equal(await joinFudcourt('123456789012345678', ''), null);
		assert.equal(await joinFudcourt('123456789012345678', null), null);
		assert.equal(await joinFudcourt('not-an-id', 'test-token'), null);
		assert.equal(await joinFudcourt(null, 'test-token'), null);
		assert.equal(await joinFudcourt('123', 'test-token'), null);
	} finally {
		globalThis.fetch = orig;
	}
});

test('FUDCOURT_GUILD_ID is the FUDCourt server', () => {
	assert.equal(FUDCOURT_GUILD_ID, '1358116767217614898');
});
