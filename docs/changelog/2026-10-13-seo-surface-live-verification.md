# The SEO surface, verified live — and three defects found while verifying it

The head rewrite (`server/lib/head.mjs`), the registry-driven sitemap and the
soft-404 fix were written but never checked against the deployed site. Checking
them live found three defects, two of them in the checks themselves.

## What the deployed surface looked like before

`https://ai.karepmuwes.my.id` served the Vite shell with **no `<title>`, no
description, no canonical and no robots tag at all** — the shell had been emptied of
its SEO tags (so the per-request rewrite is the only source of them) while the
running console process predated `head.mjs`. The sitemap was the old hardcoded list
of ten paths, including `/playground` and `/status`, both of which are deleted
pages, so the sitemap advertised 404s, and every `<loc>` was `http://` on an
HTTPS-only host.

## Defect 1: the canonical, sitemap and robots advertised a scheme the site redirects

`index.mjs` built all three origins as `${req.protocol}://${req.get('host')}`.
Express only believes `X-Forwarded-Proto` when `trust proxy` is set, and the tunnel
terminates TLS while caddy dials `:3002` in plaintext, so `req.protocol` is `'http'`
on every deployed request. Measured on a local server with the exact header caddy
sends (`X-Forwarded-Proto: https`): the canonical, every sitemap `<loc>` and the
robots `Sitemap:` line all still read `http://`.

`trust proxy` is not the fix: it also makes `req.ip` believe `X-Forwarded-For`, which
is the spoofing hole `lib/ip.mjs`'s right-to-left walk exists to close. The scheme is
now derived in `requestOrigin()` under the SAME trusted-peer test as the client IP —
the socket peer must be a trusted proxy before its header is believed, only
`http`/`https` are accepted, and the value comes from the last hop.

Verified live after deploying: canonical `https://`, all 7 sitemap URLs `https://`,
robots `Sitemap: https://…`; with no forwarding header (a LAN caller) all three
stay `http://`, which is the listener's own scheme.

## Defect 2: the suite tested whichever server answered the port

`tests/integration/seo-surface.test.mjs` spawned on a hardcoded **3199** and waited
for `/robots.txt` to answer — which is not a readiness check at all. Another project
on this box (a Next.js app) already listened on 3199, so the probe was satisfied by
that server and **all seven tests in the file asserted against a foreign app**. The
failures were real, the cause was not: they described a Next.js bundle, not this repo.

The file now uses the harness's `startServer()`, which takes an ephemeral port
(chosen by binding port 0) and waits for this server's own `/api/health`, so a
collision is impossible and a foreign listener fails the run instead of
impersonating the console.

## Defect 3: the surface lock's own note was wrong in two ways

`packages/contracts/routes.json`'s note told a reader to regenerate it with
`npm run extract -w <a package this repo does not have>` — that command does not
resolve — and claimed `line` "IS recorded and IS checked", while both checks
(`extract-routes.mjs`'s keyset and `gen-openapi-management.mjs`'s comparison)
deliberately exclude or normalise line numbers. The claim and the code disagreed.

The note now reads the workspace name from its own `package.json`, so it can no
longer name a package the script does not belong to, and it states what the checks
actually do: `line` is recorded for the OpenAPI citations, and it is deliberately
NOT part of the staleness comparison because a registration that merely shifted is not a
surface change.

## Verified

- `npm run extract -w <contracts> --check` and `gen-openapi-management --check`
  are green; removing one management route from `routes.json` turns the lock red with
  the route named, so the gate is still seen to fail.
- The robots rule is pinned twice: `lib/ip.test.mjs` (unit, including that a
  spoofed scheme from an untrusted peer is ignored and that a value that is not a
  scheme is refused) and `seo-surface.test.mjs` (over real HTTP, that a trusted
  proxy scheme reaches canonical, `<loc>` and the robots line, and that no header
  leaves them `http`). Reverting the sitemap to `req.protocol` turns the
  integration test red.
- The port fix is proven by running the file with a foreign server on 3199:
  7 failures before, 8 passes after.
- Live: `/` and `/pricing` answer distinct titles, descriptions, canonicals and
  `og:title`; `/nonsense-page-xyz` answers **404** with `noindex`; `/og.png`
  answers 200 `image/png`; HSTS, `X-Frame-Options`, `X-Content-Type-Options`,
  CSP and `Referrer-Policy` are present.
- `robots.txt` is cached at the CDN edge: the first request after the deploy
  answered the pre-deploy body with `cf-cache-status: HIT` and `age: 6166`, and a
  cache-busted request answered the correct `https://` line. A robots change
  therefore reaches crawlers on the edge cache's schedule, not ours.
