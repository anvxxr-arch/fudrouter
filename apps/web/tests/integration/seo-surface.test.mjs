// The SEO surface over real HTTP, against a real server on a real port.
//
// Why a separate file from head.test.mjs: that one asserts the pure functions
// (headFor, withHead, seoFor) and passes even when the server never calls them.
// It did exactly that — the first live sweep found `/` still serving the shell's
// static tags because `express.static(DIST)` answered it before the fallback,
// and `/docs` serving the section's noindex because `/docs/*` matched the
// prefix. Both were invisible to the unit file and obvious to curl.
//
// So this boots the server as a subprocess (index.mjs calls app.listen at import
// time, so importing it would bind a port as a side effect) with NODE_ENV=test —
// production sets trustedOrigins: [] and would reject the test origin — and
// asserts the surface a crawler sees.
//
// Skipped without a database, like every other integration test here: the
// /api/* assertions read real tables.
//
// The port is NOT a literal. This file used to spawn on a hardcoded 3199 and
// wait for /robots.txt to answer, which is not a readiness check at all: any
// other process already on 3199 satisfied it, so the suite silently asserted
// against a foreign server and reported seven failures that had nothing to do
// with this repo. `startServer` takes an ephemeral port and waits for this
// server's own /api/health, so a collision is impossible and a foreign listener
// fails the run instead of impersonating the console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, integrationEnabled } from './harness.mjs';

// One predicate, shared with the harness: it throws when DATABASE_URL names the
// application database (so a prod DSN fails loudly rather than writing to
// production) and returns false when there is no DSN at all.
const hasDb = integrationEnabled();
const SKIP = 'no throwaway DATABASE_URL — integration suite skipped';

let server;

test.before(async () => {
	if (!hasDb) return;
	server = await startServer();
});

test.after(async () => {
	await server?.stop();
});

const get = async (path) => {
	const res = await fetch(`${server.baseUrl}${path}`);
	return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};
const attr = (html, re) => {
	const m = re.exec(html);
	return m ? m[1] : null;
};

test('every public page carries its own title, description, canonical and OG', { skip: !hasDb && SKIP }, async () => {
	const pages = ['/', '/models', '/providers', '/pricing', '/docs', '/changelog', '/legal/terms', '/legal/privacy', '/login', '/signup'];
	for (const p of pages) {
		const { status, type, body } = await get(p);
		assert.equal(status, 200, `${p} status`);
		assert.ok(type.includes('text/html'), `${p} is not html`);
		const title = attr(body, /<title>([^<]+)<\/title>/);
		assert.ok(title, `${p} has no title`);
		assert.ok(attr(body, /name="description" content="([^"]+)"/), `${p} has no description`);
		assert.ok(attr(body, /name="robots" content="([^"]+)"/), `${p} has no robots tag`);
		assert.ok(attr(body, /property="og:title" content="([^"]+)"/), `${p} has no og:title`);
		assert.ok(attr(body, /name="twitter:card" content="([^"]+)"/), `${p} has no twitter card`);
		assert.equal(
			attr(body, /rel="canonical" href="([^"]+)"/),
			`${server.baseUrl}${p}`,
			`${p} canonical`,
		);
	}
	// The landing page's title must not be the one every route serves — that was
	// the bug, and a shared-title assertion is what would have missed it. Each
	// body is used once: the previous form fetched /models a second time inside
	// an assertion argument (and carried a `home === null` branch that cannot be
	// taken), which read as a third comparison that never happened.
	const TITLE = /<title>([^<]+)<\/title>/;
	const [models, home, pricing] = await Promise.all([get('/models'), get('/'), get('/pricing')]);
	assert.notEqual(attr(pricing.body, TITLE), attr(home.body, TITLE), 'pricing shares the landing title');
	assert.notEqual(attr(pricing.body, TITLE), attr(models.body, TITLE), 'pricing shares the models title');
	assert.match(pricing.body, /robots" content="index,follow"/);
});

test('a detail page is noindex but still 200', { skip: !hasDb && SKIP }, async () => {
	for (const p of ['/models/grok-4.6', '/docs/api/errors', '/models/compare']) {
		const { status, body } = await get(p);
		assert.equal(status, 200, `${p} status`);
		assert.match(body, /name="robots" content="noindex/, `${p} must be noindex`);
	}
});

test('the docs index keeps its own indexable entry', { skip: !hasDb && SKIP }, async () => {
	// /docs/* matching /docs made the index serve the section's noindex, and the
	// wildcard outranked the exact entry on pattern length. Both directions are
	// asserted: the index is indexable, a page under it is not.
	const index = await get('/docs');
	assert.match(index.body, /name="robots" content="index,follow"/);
	const page = await get('/docs/api/errors');
	assert.match(page.body, /name="robots" content="noindex,follow"/);
});

test('an unknown path answers 404, not a 200 shell', { skip: !hasDb && SKIP }, async () => {
	for (const p of ['/nonsense', '/models/compare/x', '/totally/made/up']) {
		const { status, body } = await get(p);
		assert.equal(status, 404, `${p} must 404`);
		assert.match(body, /name="robots" content="noindex/, `${p} must be noindex`);
		// The SPA still ships: this is a status fix, not a body change.
		assert.match(body, /<div id="root"><\/div>/);
	}
});

test('the sitemap lists every indexable path and every one of them resolves', { skip: !hasDb && SKIP }, async () => {
	const { status, type, body } = await get('/sitemap.xml');
	assert.equal(status, 200);
	assert.ok(type.includes('xml'));
	const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	assert.equal(locs.length, 7, `sitemap has ${locs.length} urls`);
	// Parameterised and guarded routes must not be listed: the registry cannot
	// enumerate their rows, and listing a guarded one invites a crawl of a
	// redirect.
	assert.ok(!locs.some((l) => l.includes('/models/') || l.includes('/dashboard') || l.includes('/docs/')), `leaked: ${locs}`);
	assert.ok(locs.includes(`${server.baseUrl}/pricing`), 'pricing missing from sitemap');
	// Every advertised URL must actually answer 200 — a sitemap of 404s is worse
	// than no sitemap.
	for (const loc of locs) {
		const { status: s } = await get(new URL(loc).pathname);
		assert.equal(s, 200, `${loc} from the sitemap`);
	}
	assert.match(body, /<changefreq>/, 'no change hints');
});

test('marketing JSON-LD is valid JSON', { skip: !hasDb && SKIP }, async () => {
	for (const p of ['/', '/models', '/providers']) {
		const { body } = await get(p);
		const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(body);
		assert.ok(m, `${p} has no JSON-LD block`);
		const parsed = JSON.parse(m[1]); // throws on a hand-built string
		assert.equal(parsed['@context'], 'https://schema.org');
	}
});

test('a trusted proxy scheme reaches canonical, sitemap and robots', { skip: !hasDb && SKIP }, async () => {
	// The tunnel terminates TLS and caddy dials this server in PLAINTEXT, so
	// `req.protocol` is 'http' on every deployed request and the only evidence of
	// https is the X-Forwarded-Proto header. This is the assertion that the
	// deployed scheme is right: an http:// canonical, <loc> or Sitemap line is a
	// URL that HSTS redirects, which is the signal crawlers are told to ignore.
	//
	// The socket peer here is loopback, which is a trusted proxy by default
	// (ROUTER_TRUSTED_PROXIES), so the header is believed exactly as caddy's is.
	const proxied = async (path) => {
		const res = await fetch(`${server.baseUrl}${path}`, { headers: { 'x-forwarded-proto': 'https' } });
		return { status: res.status, body: await res.text() };
	};
	const page = await proxied('/pricing');
	assert.equal(
		attr(page.body, /rel="canonical" href="([^"]+)"/),
		`https://127.0.0.1:${server.port}/pricing`,
		'canonical behind the proxy'
	);
	const sitemap = await proxied('/sitemap.xml');
	const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	assert.ok(locs.length > 0, 'sitemap is empty');
	assert.ok(locs.every((l) => l.startsWith('https://')), `sitemap leaked a non-https url: ${locs}`);
	const robots = await proxied('/robots.txt');
	assert.match(robots.body, /^Sitemap: https:\/\//m, `robots advertised ${robots.body}`);

	// And with NO forwarding header the listener's own scheme is the truth —
	// a LAN caller is not told the site is https.
	const direct = await get('/pricing');
	assert.equal(
		attr(direct.body, /rel="canonical" href="([^"]+)"/),
		`${server.baseUrl}/pricing`,
		'canonical without a proxy header'
	);
});

test('the API and asset surfaces are unchanged', { skip: !hasDb && SKIP }, async () => {
	for (const p of ['/api/models', '/api/pricing', '/api/status', '/api/docs', '/api/changelog', '/api/providers', '/api/metrics']) {
		const { type } = await get(p);
		assert.ok(type.includes('application/json'), `${p} content-type ${type}`);
	}
	// A missing asset path must not fall through to the shell: express.static for
	// /assets is still mounted, and the SPA fallback excludes only /api/*.
	const robots = await get('/robots.txt');
	assert.ok(robots.body.includes('Sitemap:'));
	assert.ok(robots.body.includes('Disallow: /dashboard'));
});
