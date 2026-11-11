// The SEO surface: the route registry, the server's head renderer, and the
// sitemap built from it.
//
// Why this file exists: before it, the head was index.html's static tags plus a
// fourteen-entry regex table inside App.tsx, and the sitemap was a hardcoded
// list of ten paths in index.mjs. Nothing connected them, so nothing could fail
// when they diverged — and they had: every public route answered with the
// landing page's title and a canonical to `/`.
//
// The gate must be able to fail. Two ways it does: `isKnownRoute` decides
// whether an unknown path is a 404 (a typo would otherwise be indexable), and
// the sitemap is asserted to contain EVERY indexable registry path — a path
// added to the registry without reaching the sitemap is the exact drift the
// registry was introduced to stop. Both are exercised below with the real
// modules, not with copies.
//
// head.mjs imports src/lib/seo.ts at runtime (Node strips the types), which is
// what lets this be a plain node:test file with no bundler and no server boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/lib/ -> apps/web/
const WEB = join(HERE, '..', '..');

// Absolute specifiers: this file lives in server/lib/, so a bare '../src/...'
// would resolve one level too shallow. Node needs the explicit extension for a
// .ts module.
const seo = await import(join(WEB, 'src/lib/seo.ts'));
const head = await import(join(HERE, 'head.mjs'));

const ORIGIN = 'https://router.example';

test('every public nav route has SEO metadata', () => {
	// navigation.ts is TypeScript, so it cannot be JSON.parsed; the real
	// assertion is below: a PUBLIC_NAV entry whose pattern is absent from
	// PUBLIC_SEO would ship a page with the generic fallback title.
	const navSource = readFileSync(join(WEB, 'src/lib/navigation.ts'), 'utf8');
	const publicPatterns = [...navSource.matchAll(/\{ to: "([^"]+)", label: "[^"]+", scope: "public"/g)].map(
		(m) => m[1],
	);
	// 6 → 5 when /signup stopped being a destination: the Discord round trip is
	// the single door, so a "Sign up" nav entry would point at a page with no
	// chrome of its own. Asserted below as a fact so it cannot be re-added in
	// silence — this count is the tripwire, not decoration.
	assert.ok(publicPatterns.length >= 5, `only ${publicPatterns.length} public nav entries parsed`);
	assert.ok(
		!publicPatterns.includes('/signup'),
		'/signup is a redirect to /login, not a nav destination — a nav entry here would advertise a forwarding path',
	);
	for (const pattern of publicPatterns) {
		assert.ok(
			seo.PUBLIC_SEO.some((m) => m.to === pattern),
			`public route ${pattern} has no SEO entry — it would render the generic fallback title`,
		);
	}
});

test('a wildcard route is not in the sitemap but still resolves a title', () => {
	// The distinction that matters: /docs/* and /changelog/* are real pages
	// with their own metadata, but they are PATTERNS, not URLs — the sitemap
	// must not pretend to list them. (This was asserted against /models/:slug
	// while that route existed; /docs/* and /changelog/* are the parameterised
	// entries the registry still carries.)
	assert.ok(!seo.sitemapPaths().includes('/docs/*'));
	assert.ok(!seo.sitemapPaths().includes('/changelog/*'));
	const meta = seo.seoFor('/docs/api/errors');
	assert.equal(meta.indexable, false);
	assert.match(meta.title, /Documentation/);
	const entry = seo.seoFor('/changelog/2026-10-18-sse-ttft-gate');
	assert.equal(entry.indexable, false);
	assert.match(entry.title, /Changelog/);
});

test('every INDEXABLE route has search-useful title and description lengths', () => {
	// Why: a title over ~60 characters is truncated in a result snippet, and a
	// description under ~70 reads as a stub, which is what /changelog,
	// /legal/terms and /legal/privacy shipped with (44, 37 and 32 characters —
	// measured) before they were withdrawn. Length is not the goal, but a
	// description that short cannot say what the page is FOR, and a crawler
	// treats the snippet as low quality. The rule outlives those routes: it is
	// what any page added back to the sitemap is measured against.
	//
	// Only indexable routes are asserted: a noindex page's snippet is never used,
	// so its length is not a defect.
	for (const path of seo.sitemapPaths()) {
		const meta = seo.seoFor(path);
		assert.equal(meta.indexable, true, `${path} is in the sitemap but not indexable`);
		assert.ok(
			meta.title.length <= 60,
			`${path} title is ${meta.title.length} chars (max 60): "${meta.title}"`,
		);
		assert.ok(
			meta.description.length >= 70,
			`${path} description is only ${meta.description.length} chars (min 70): "${meta.description}"`,
		);
		assert.ok(
			meta.description.length <= 165,
			`${path} description is ${meta.description.length} chars (max 165): "${meta.description}"`,
		);
	}
	// The registry must not carry the same snippet twice — duplicate descriptions
	// across indexable pages are a duplicate-content signal.
	const seen = new Map();
	for (const path of seo.sitemapPaths()) {
		const { description } = seo.seoFor(path);
		assert.ok(
			!seen.has(description),
			`${path} shares its description with ${seen.get(description)}`,
		);
		seen.set(description, path);
	}
});

test('sitemapPaths contains every indexable, non-parameterised path', () => {
	const expected = seo.PUBLIC_SEO.filter(
		(m) => m.indexable && !m.to.includes(':') && !m.to.includes('*'),
	).map((m) => m.to);
	assert.deepEqual([...seo.sitemapPaths()].sort(), [...expected].sort());
	assert.ok(expected.includes('/pricing'), 'pricing must be indexable');
	assert.ok(expected.includes('/docs'), 'docs must be indexable');
});

test('the sitemap is exactly the indexable content pages', () => {
	// The public surface is /pricing, /models, /changelog, /docs and the three
	// trust pages (/security, /terms, /privacy), and this is the assertion that
	// keeps the sitemap honest about it. A hardcoded set here would be the very
	// drift the registry exists to prevent, so the expected set is DERIVED from
	// PUBLIC_SEO and then checked to be those paths — if a page is withdrawn or
	// added, this test is where the change must be acknowledged rather than
	// silently shipped.
	const paths = [...seo.sitemapPaths()].sort();
	assert.deepEqual(
		paths,
		['/changelog', '/docs', '/features', '/integrations', '/models', '/pricing', '/privacy', '/security', '/terms'],
		`sitemap drifted: ${paths}`,
	);
	// The root is a real page but stays noindex: its offer is /pricing's
	// restated, so listing it would advertise a duplicate under a second URL.
	assert.ok(!paths.includes('/'), '/ must not be in the sitemap — it is noindex');
});

test('the exact-depth rule keeps a sub-path out of a page it does not belong to', () => {
	// The longest-match rule still has to hold with a thin registry: `/docs`
	// matches the /docs entry, and a path under it matches the `/docs/*`
	// section entry rather than falling back to the generic title. A naive
	// prefix check would hand `/docs/api/errors` the INDEX's metadata.
	assert.match(seo.seoFor('/docs/api/errors').title, /Documentation/);
	assert.match(seo.seoFor('/docs').title, /Documentation/);
	// Exact depth: a pattern with no trailing `*` must not claim a deeper path,
	// so /pricing is not matched by anything at depth 2.
	assert.equal(seo.patternMatches('/pricing', '/pricing/deep'), false);
});

test('guarded and unknown routes are noindex', () => {
	for (const p of ['/dashboard', '/dashboard/keys', '/admin/models', '/dashboard/settings', '/nonsense']) {
		assert.equal(seo.seoFor(p).indexable, false, `${p} must not be indexable`);
	}
});

test('isKnownRoute separates a served page from a typo', () => {
	for (const p of [
		'/',
		'/pricing',
		'/models',
		'/changelog',
		'/changelog/2026-10-18-sse-ttft-gate',
		'/docs',
		'/docs/api/errors',
		'/login',
		'/signup',
		'/dashboard/keys',
		'/admin/models',
	]) {
		assert.equal(seo.isKnownRoute(p), true, `${p} must be known`);
	}
	// The withdrawal, asserted as a fact rather than left implicit: these were
	// served pages, so a stale entry for any of them would answer 200 with a
	// shell for a page that no longer exists — a soft 404 a crawler indexes.
	// This is the list to revisit if one of them comes back. /changelog and the
	// catalogue left it when their pages were rebuilt; the legal pages did not.
	// /invite left it with the workspace hierarchy in migration 0019.
	for (const p of ['/models/compare', '/providers', '/providers/xai', '/legal/terms', '/legal/privacy', '/invite/tok_1']) {
		assert.equal(seo.isKnownRoute(p), false, `${p} was withdrawn and must be unknown`);
	}
	// Exact depth matters: `/admin` is a real route while `/dashboardish` is a
	// prefix of one and must not be. A naive `startsWith` gets the second wrong.
	for (const p of ['/nonsense', '/pricing/deep', '/admin', '/dashboardish']) {
		const known = seo.isKnownRoute(p);
		assert.equal(known, p === '/admin', `${p}: known=${known}`);
	}
});

test('a wildcard needs a remainder, so /docs keeps its own entry', () => {
	// Two bugs the live route smoke test caught, pinned here so they cannot come
	// back: `/docs/*` matching `/docs` (and outranking it on pattern length) made
	// the docs INDEX serve the section's noindex; and the same wildcard logic
	// decides `isKnownRoute`.
	assert.equal(seo.seoFor('/docs').indexable, true, '/docs must be indexable');
	assert.equal(seo.seoFor('/docs').title.includes('Documentation'), true);
	assert.equal(seo.seoFor('/docs/api/errors').indexable, false, 'a docs page must be noindex');
	assert.equal(seo.isKnownRoute('/docs'), true);
	assert.equal(seo.isKnownRoute('/docs/api/errors'), true);
	// The wildcard must not match the prefix itself.
	assert.equal(seo.patternMatches('/docs/*', '/docs'), false);
	assert.equal(seo.patternMatches('/docs/*', '/docs/api'), true);
});

test('headFor renders the route title, description, canonical and robots', () => {
	const html = head.headFor('/pricing', ORIGIN);
	const name = seo.SITE_NAME;
	assert.equal(html.includes(`<title>Pricing — per-1M-token rates | ${name}</title>`), true, html);
	assert.match(html, /<link rel="canonical" href="https:\/\/router\.example\/pricing" \/>/);
	assert.match(html, /<meta name="robots" content="index,follow" \/>/);
	assert.match(html, /<meta property="og:url" content="https:\/\/router\.example\/pricing" \/>/);
	// The landing page's own title must NOT leak into another route's head.
	assert.equal(html.includes(`<title>${name} — ${seo.SITE_TAGLINE}</title>`), false, 'landing title leaked');
});

test('headFor marks an unknown path noindex and escapes a hostile Host', () => {
	const html = head.headFor('/nonsense', ORIGIN);
	assert.match(html, /<meta name="robots" content="noindex,follow" \/>/);

	// Origin comes from the request's Host header, which a client controls: an
	// unescaped interpolation is reflected XSS in every page's <head>.
	const hostile = head.headFor('/pricing', 'https://x"><script>alert(1)</script>');
	assert.ok(!hostile.includes('<script>alert(1)</script>'), 'Host header was not escaped');
	assert.match(hostile, /&quot;&gt;&lt;script&gt;/);
});

test('withHead replaces the shell head instead of appending a second set', () => {
	const shell = readFileSync(join(WEB, 'index.html'), 'utf8');
	const once = head.withHead(shell, '/pricing', ORIGIN);
	assert.equal((once.match(/<title>/g) ?? []).length, 1, 'two <title> tags in the head');
	assert.equal((once.match(/rel="canonical"/g) ?? []).length, 1, 'two canonical links');
	assert.match(once, /Pricing — per-1M-token rates/);
	// The body and the module script must survive untouched: this is a head
	// rewrite, not a renderer.
	assert.match(once, /<div id="root"><\/div>/);
	assert.match(once, /src="\/src\/main\.tsx"/);
	// The shell now carries NO tags the rewrite owns, so the marker deletion
	// loop finds zero spans. That must still produce a full head — an early
	// return there shipped pages with no title at all (caught by this file).
	const bare = '<!doctype html><html lang="en"><head>\n</head><body>x</body></html>';
	const fixed = head.withHead(bare, '/pricing', ORIGIN);
	assert.match(fixed, /<title>Pricing — per-1M-token rates/, 'a shell with no SEO tags got no head');
	assert.equal((fixed.match(/rel="canonical"/g) ?? []).length, 1);
});

test('withHead strips a stale JSON-LD block instead of appending a second one', () => {
	// HEAD_MARKERS owns `application/ld+json`, so a shell that still carries a
	// block must lose it: two blocks on one page is duplicate structured data
	// served to every crawler. The current index.html carries no such tag (that
	// is asserted by `the shell carries only tags the head rewrite leaves alone`
	// below), which makes this synthetic shell the ONLY thing exercising the
	// strip. Drop the marker from HEAD_MARKERS and the stale block survives,
	// turning this red.
	const stale =
		'<!doctype html><html lang="en"><head>\n' +
		'<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"STALE"}</script>\n' +
		'</head><body>x</body></html>';
	const stripped = head.withHead(stale, '/pricing', ORIGIN);
	assert.equal(
		(stripped.match(/application\/ld\+json/g) ?? []).length,
		1,
		'a stale JSON-LD block survived the rewrite',
	);
	assert.ok(!stripped.includes('STALE'), 'the shell block is still in the head');
	// The survivor must be the ROUTE block, not a rewritten shell block.
	const kept = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(stripped)[1]);
	assert.equal(kept['@type'], 'ItemList', 'the surviving block is not the route block');
});

test('a JSON-LD block is emitted exactly for the routes that declare one', () => {
	// Derived from the registry, never from a hardcoded path list. A previous
	// version pinned `/pricing` as "the route that declares no block" while the
	// same change gave it an `ItemList` in seo.ts — so the assertion measured its
	// own example instead of the rule, and went red on a deliberate improvement.
	// Iterating PUBLIC_SEO moves a route that gains JSON-LD to the positive side
	// automatically, and checks the emitted @type against what was declared.
	let without = 0;
	for (const meta of seo.PUBLIC_SEO) {
		const html = head.headFor(meta.to, ORIGIN);
		const block = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
		if (!meta.jsonLd) {
			without++;
			assert.ok(!block, `${meta.to} declares no jsonLd but shipped a block`);
			continue;
		}
		assert.ok(block, `${meta.to} declares ${meta.jsonLd} but shipped no block`);
		// Parse it: the block must be valid JSON, not a hand-built string.
		assert.equal(JSON.parse(block[1])['@type'], meta.jsonLd, meta.to);
	}
	// The loop must have a negative case to be worth running. If every route
	// ever declares JSON-LD, "only declared routes emit a block" is untested.
	assert.ok(without > 0, 'every public route declares JSON-LD — the negative case is untested');
	// `ItemList` is the only branch the registry reaches now — /pricing is the
	// one route that declares a block. The root used to declare
	// `SoftwareApplication`; it is a landing page whose offer duplicates
	// /pricing's, so a block describing it would describe the same product
	// twice. That negative is asserted above by the loop (the root declares
	// none), which is why it is not repeated as a positive here.
	assert.match(head.headFor('/pricing', ORIGIN), /"@type":"ItemList"/);
});

test('every head carries an absolute social card and a large-image card type', () => {
	// A preview with no image renders as a small text-only card. The card type
	// and the image must move together: `summary` shows a thumbnail and
	// `summary_large_image` requires the image, so declaring the large type
	// without the asset is a broken preview, not a degraded one.
	for (const p of ['/', '/docs', '/pricing']) {
		const html = head.headFor(p, ORIGIN);
		assert.match(html, new RegExp(`<meta property="og:image" content="${ORIGIN}${seo.OG_IMAGE_PATH}" />`), p);
		assert.match(html, /<meta property="og:image:width" content="1200" \/>/, p);
		assert.match(html, /<meta property="og:image:height" content="630" \/>/, p);
		assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/, p);
		assert.match(html, new RegExp(`<meta name="twitter:image" content="${ORIGIN}${seo.OG_IMAGE_PATH}" />`), p);
		// og:url was asserted by name before while only the SHELL ever emitted
		// it — the shell tag is stripped by the marker rewrite, so the page
		// shipped without it. Assert the rendered head, which is what ships.
		assert.match(html, new RegExp(`<meta property="og:url" content="${ORIGIN}${p}" />`), p);
	}
});

test('the declared social card is a real 1200x630 file the server mounts', () => {
	// The registry path and the file on disk are two independent statements;
	// this is the one place they are compared. A renamed asset or a typo in
	// OG_IMAGE_PATH would otherwise ship a preview URL that 404s — and a
	// scraper cannot render the SPA to discover that.
	const asset = join(WEB, 'public', seo.OG_IMAGE_PATH.replace(/^\//, ''));
	const buf = readFileSync(asset);
	assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${asset} is not a PNG`);
	// IHDR width/height are big-endian uint32 at offsets 16 and 20.
	assert.equal(buf.readUInt32BE(16), 1200, 'og.png width');
	assert.equal(buf.readUInt32BE(20), 630, 'og.png height');

	// And the server must actually serve it statically: /assets is
	// content-hashed and would answer a moving URL, so the card lives in the
	// durable directory and the route has to mount that directory.
	const server = readFileSync(join(WEB, 'server', 'index.mjs'), 'utf8');
	assert.match(server, /express\.static\(path\.join\(__dirname, '\.\.', 'public'\)/);
});

test('the shell carries only tags the head rewrite leaves alone', () => {
	// The class of bug this pins: a tag in index.html that head.mjs strips is
	// invisible to the rewrite's "no duplicate" guarantee, so it silently
	// disappears from every page. The shell used to hardcode the site name and
	// description as og:site_name/og:description; those strings disagree with
	// SITE_NAME/SITE_DESCRIPTION in the registry, so a crawler's first paint and
	// a client-side navigation could name the product differently.
	const shell = readFileSync(join(WEB, 'index.html'), 'utf8');
	const headming = [
		'<title>',
		'name="description"',
		'name="robots"',
		'property="og:',
		'name="twitter:',
		'rel="canonical"',
		'application/ld+json',
	];
	for (const marker of headming) {
		assert.equal(shell.includes(marker), false, `index.html still hardcodes ${marker} — head.mjs strips it`);
	}
	// The durable assets must be linked from the shell, or a browser never asks
	// for them.
	assert.match(shell, /rel="manifest" href="\/site\.webmanifest"/);
	assert.match(shell, /rel="apple-touch-icon" href="\/icon-192\.png"/);
});
test('every console route carries its own title instead of the landing page\'s', () => {
	// The bug this pins: `seoFor` matched PUBLIC_SEO only, so all twelve
	// /dashboard/* routes fell through to the generic fallback — the landing
	// page's title — in a signed-in browser tab. A crawler never saw it (the
	// server renders the shell head for a guarded route and redirects an
	// anonymous request to /login), so only a person with twelve tabs open
	// could tell. The fix is GUARDED_SEO, consulted by seoFor but NOT by
	// sitemapPaths or isKnownRoute, which is asserted here too.
	const consoleRoutes = [
		'/dashboard',
		'/dashboard/keys',
		'/dashboard/usage',
		'/dashboard/logs',
		'/dashboard/playground',
		'/dashboard/limits',
		'/dashboard/budgets',
		'/dashboard/aliases',
		'/dashboard/routing',
		'/dashboard/alerts',
		'/dashboard/billing',
		'/dashboard/settings',
	];
	const landing = `${seo.SITE_NAME} — ${seo.SITE_TAGLINE}`;
	for (const route of consoleRoutes) {
		const meta = seo.seoFor(route);
		assert.notEqual(meta.title, landing, `${route} still renders the landing page's title`);
		assert.match(meta.title, new RegExp(`\\| ${seo.SITE_NAME}$`), `${route} title must name the product`);
		assert.equal(meta.indexable, false, `${route} must stay noindex`);
	}
	// The billing sub-routes are registry-only (nav: false) but are still pages
	// a signed-in user opens, so they need titles of their own rather than
	// /dashboard/billing's — the longest-match rule has to hold here too.
	assert.match(seo.seoFor('/dashboard/billing/credits').title, /Credits/);
	assert.match(seo.seoFor('/dashboard/billing/invoices').title, /Invoices/);
	assert.match(seo.seoFor('/dashboard/billing/payment-methods').title, /Payment methods/);
	assert.match(seo.seoFor('/dashboard/account').title, /Account/);
	// /admin is one entry for the whole tree: the hub swaps sections in place.
	assert.match(seo.seoFor('/admin').title, /Admin console/);
	assert.match(seo.seoFor('/admin/models').title, /Admin console/);
	// The crawler's view must not move: no guarded path reaches the sitemap.
	const sitemap = seo.sitemapPaths();
	for (const route of [...consoleRoutes, '/admin', '/dashboard/billing/credits']) {
		assert.equal(sitemap.includes(route), false, `${route} leaked into the sitemap`);
	}
	// And the guarded table must not make an unknown path "known".
	assert.equal(seo.isKnownRoute('/dashboard/nope'), true, 'a guarded prefix is served by the SPA shell');
	assert.equal(seo.isKnownRoute('/nonsense'), false, 'an unknown path is still a 404');
});
