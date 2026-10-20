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
	const pages = [
		'/',
		'/pricing',
		'/models',
		'/changelog',
		'/docs',
		'/login',
		'/signup',
		'/features',
		'/integrations',
		'/security',
		'/terms',
		'/privacy',
	];
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
	// No route may serve another's title. The original bug was every route
	// serving the landing page's title and a canonical to `/`, a
	// duplicate-content signal; with the surface down to two content pages the
	// pair that matters is pricing vs docs, which are the two the sitemap
	// advertises. Each body is fetched once and compared by value.
	const TITLE = /<title>([^<]+)<\/title>/;
	const [pricing, docs] = await Promise.all([get('/pricing'), get('/docs')]);
	assert.notEqual(attr(pricing.body, TITLE), attr(docs.body, TITLE), 'pricing shares the docs title');
	assert.match(pricing.body, /robots" content="index,follow"/);
	assert.match(docs.body, /robots" content="index,follow"/);
});

test('the withdrawn pages are gone, not merely unlinked', { skip: !hasDb && SKIP }, async () => {
	// The public surface is /pricing, /models, /changelog, /docs, /features,
	// /integrations and the three trust pages (/security, /terms, /privacy).
	// Unlinking a page is not withdrawing it: if the route still resolved, every
	// URL that used to be shared, bookmarked or indexed would keep answering 200
	// with a shell that renders the SPA's NotFound page — a soft 404, which is
	// exactly the state the 404 handling below exists to prevent. This asserts
	// the hard 404 on the withdrawn paths themselves, so a route accidentally
	// left in App.tsx or in the SEO registry turns this red. `/legal/terms` and
	// `/legal/privacy` are the OLD spellings: the pages now live at /terms and
	// /privacy, and the old paths must stay dead rather than become aliases.
	for (const p of ['/models/compare', '/providers', '/providers/xai', '/legal/terms', '/legal/privacy']) {
		const { status, body } = await get(p);
		assert.equal(status, 404, `${p} must 404 after withdrawal`);
		assert.match(body, /name="robots" content="noindex/, `${p} must be noindex`);
	}
});

test('a detail page is noindex but still 200', { skip: !hasDb && SKIP }, async () => {
	// /docs/api/errors and /changelog/<slug> are real pages under
	// withdrawn-from-the-sitemap subtrees: they must still render (200) while
	// telling a crawler not to index them, because the SPA renders their bodies
	// client-side. The root is noindex for a different reason — its offer
	// duplicates /pricing's, so it has no content of its own to index.
	for (const p of ['/docs/api/errors', '/changelog/2026-10-18-sse-ttft-gate', '/']) {
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
	// `/pricing/deep` is the exact-depth case: it shares a prefix with a real
	// route and must not inherit its 200, which a naive startsWith would.
	for (const p of ['/nonsense', '/pricing/deep', '/totally/made/up']) {
		const { status, body } = await get(p);
		assert.equal(status, 404, `${p} must 404`);
		assert.match(body, /name="robots" content="noindex/, `${p} must be noindex`);
		// The SPA still ships: this is a status fix, not a body change.
		assert.match(body, /<div id="root"><\/div>/);
	}
});

test('the sitemap lists exactly the indexable pages and each one resolves', { skip: !hasDb && SKIP }, async () => {
	const { status, type, body } = await get('/sitemap.xml');
	assert.equal(status, 200);
	assert.ok(type.includes('xml'));
	const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	// Nine URLs: /pricing, /models, /changelog, /docs, /features, /integrations
	// and the three trust pages (/security, /terms, /privacy) are the whole
	// indexable surface. The count is pinned rather than a lower bound because
	// a sitemap that grows silently is how a withdrawn page gets re-advertised
	// — and a sitemap of 404s is worse than no sitemap, which is what the loop
	// below exists to catch.
	assert.equal(locs.length, 9, `sitemap has ${locs.length} urls: ${locs}`);
	assert.deepEqual(
		locs.map((l) => new URL(l).pathname).sort(),
		['/changelog', '/docs', '/features', '/integrations', '/models', '/pricing', '/privacy', '/security', '/terms'],
		`sitemap advertises the wrong paths: ${locs}`,
	);
	// Nothing withdrawn, parameterised or guarded may appear: the registry
	// cannot enumerate a pattern's rows, and listing a guarded route invites a
	// crawl of a redirect. `/changelog/*` is the parameterised half of a real
	// page, so the index is listed and its entries are not. `/models/compare`
	// is still withdrawn, so the regex rejects any /models path deeper than the
	// index itself.
	assert.ok(
		!locs.some((l) => /\/models\/|\/providers|\/legal|\/dashboard|\/docs\//.test(l)),
		`leaked: ${locs}`,
	);
	assert.ok(
		!locs.some((l) => /^\/changelog\/.+/.test(new URL(l).pathname)),
		`a changelog entry leaked into the sitemap: ${locs}`,
	);
	// The root is a real page but stays noindex, so it must NOT be listed even
	// though it answers 200.
	assert.ok(!locs.some((l) => new URL(l).pathname === '/'), '/ is noindex and must not be advertised');
	assert.ok(locs.includes(`${server.baseUrl}/pricing`), 'pricing missing from sitemap');
	assert.ok(locs.includes(`${server.baseUrl}/models`), 'models missing from sitemap');
	assert.ok(locs.includes(`${server.baseUrl}/changelog`), 'changelog missing from sitemap');
	// Every advertised URL must actually answer 200.
	for (const loc of locs) {
		const { status: s } = await get(new URL(loc).pathname);
		assert.equal(s, 200, `${loc} from the sitemap`);
	}
	assert.match(body, /<changefreq>/, 'no change hints');
});

test('marketing JSON-LD is valid JSON', { skip: !hasDb && SKIP }, async () => {
	// /pricing is the only route that declares a block. Parsing it is the
	// assertion: a hand-built string that happens to match the tags would throw
	// here, which is the failure mode the tag-shape checks elsewhere miss.
	const { body } = await get('/pricing');
	const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(body);
	assert.ok(m, '/pricing has no JSON-LD block');
	const parsed = JSON.parse(m[1]);
	assert.equal(parsed['@context'], 'https://schema.org');
	assert.equal(parsed['@type'], 'ItemList');
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
