// Per-route marketing metadata — the SEO twin of lib/navigation.ts.
//
// Why a registry and not per-component side effects: navigation.ts already
// established that a per-page listing scattered across components drifts (a
// guarded route with no nav entry was unreachable; a nav item the guard refuses
// was a button that 403s). The same argument applies to titles and descriptions:
// they were inline in App.tsx's TITLES table AND in index.html's static meta, so
// the browser tab, the crawler's first paint and the sitemap could disagree.
// One table, three consumers: components/Meta.tsx (document head), the server's
// /sitemap.xml, and the tests.
//
// This file must stay importable from plain node (no JSX, no `@/` alias): the
// Express server loads it at runtime the way lib/platform-ts.mjs loads
// packages/platform/*.ts. Vite resolves the same file for the SPA, which is why
// the import specifiers here are RELATIVE.

/** The product's display name — one string, so title and OG never disagree. */
export const SITE_NAME = 'fudrouter';
/** The one-line positioning the landing page leads with. */
export const SITE_TAGLINE = 'one API key, every model';
/** The sentence every description is derived from or overrides. */
export const SITE_DESCRIPTION =
  'One API key, every model. A commercial AI router with per-request metering, rate limits, and auditable usage.';

/**
 * The link-preview card, and the path it is served at.
 *
 * `OG_IMAGE_PATH` is a top-level path rather than a hashed /assets/* file
 * because a social scraper will NOT run the SPA: the URL has to resolve to a
 * stable path on its own. The server serves this exact path from the durable
 * (non-hashed) static directory; see the route next to the /assets mount in
 * server/index.mjs.
 */
export const OG_IMAGE_PATH = '/og.png';
export const OG_IMAGE_ALT = `${SITE_NAME} — one API key, every model`;

export interface SeoMeta {
  /** Route pattern, in navigation.ts's `:param` / `*` vocabulary. */
  to: string;
  /** `document.title` for this route. */
  title: string;
  /** `<meta name="description">` for this route. */
  description: string;
  /** May a crawler index it? Guarded routes and auth screens say no. */
  indexable: boolean;
  /** Sitemap hint. Ignored when `indexable` is false. */
  changefreq?: 'daily' | 'weekly' | 'monthly';
  priority?: number;
  /** schema.org type for the route's JSON-LD block, when it has one. */
  jsonLd?: 'WebSite' | 'SoftwareApplication' | 'FAQPage' | 'ItemList';
}

/**
 * Metadata for every PUBLIC route, keyed by navigation.ts's pattern.
 *
 * The thirty-ish covered routes are the whole public surface; a console or admin
 * route is NOT listed (they all redirect an anonymous crawler to /login, so their
 * metadata would only ever be seen by a signed-in browser tab). `seoFor` falls
 * back for those.
 */
export const PUBLIC_SEO: readonly SeoMeta[] = [
  {
    to: '/',
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    indexable: true,
    changefreq: 'weekly',
    priority: 1.0,
    // SoftwareApplication, not WebSite: the landing page describes a PRODUCT
    // (a router with an OpenAI-compatible API), and `WebSite` says only "there
    // is a website here". The SoftwareApplication branch in `jsonLdFor` was
    // dead until this line — no route declared it — so the richest block
    // available was never emitted anywhere.
    jsonLd: 'SoftwareApplication',
  },
  {
    to: '/models',
    title: `Models — every model one key reaches | ${SITE_NAME}`,
    description:
      'Browse every model this deployment serves through the OpenAI-compatible API, with providers, context windows and normalized per-1M-token prices.',
    indexable: true,
    changefreq: 'daily',
    priority: 0.9,
    jsonLd: 'ItemList',
  },
  {
    to: '/models/compare',
    title: `Compare models side by side | ${SITE_NAME}`,
    description:
      'Put two or more models next to each other — price per 1M tokens, context window, capabilities and which providers serve them.',
    indexable: false,
  },
  {
    to: '/models/:slug',
    title: `Model details | ${SITE_NAME}`,
    description:
      'One model: its providers, price, context window and a ready-to-paste request. Every slug is also in the catalogue at /models.',
    indexable: false,
  },
  {
    to: '/providers',
    title: `Provider network | ${SITE_NAME}`,
    description:
      'The upstream AI providers behind the router: which models each serves, its regions, observed latency and current availability.',
    indexable: false,
    changefreq: 'weekly',
    priority: 0.8,
    jsonLd: 'ItemList',
  },
  {
    to: '/providers/:slug',
    title: `Provider details | ${SITE_NAME}`,
    description:
      'One provider: the models it serves here, its pricing overrides, latency percentiles and recent incidents.',
    indexable: false,
  },
  {
    to: '/pricing',
    title: `Pricing — per-1M-token rates | ${SITE_NAME}`,
    description:
      'Every model price in one table, grouped by developer: input, cached input, output and reasoning rates in micro-units per 1M tokens.',
    indexable: true,
    changefreq: 'daily',
    priority: 0.9,
    // ItemList, like /models: this is the page whose whole payload is the
    // catalogue's rows, and it is the one of the two that a crawler can index
    // (the provider page's block is emitted but that route is noindex). The
    // `jsonLdFor` ItemList branch was reachable from /models only before this
    // line — the price-bearing page, which is the one a search result wants,
    // carried no structured data at all.
    jsonLd: 'ItemList',
  },
  {
    to: '/docs',
    title: `Documentation | ${SITE_NAME}`,
    description:
      'How the router works: authentication, chat completions, streaming, routing and fallback, errors, rate limits, billing and usage.',
    indexable: true,
    changefreq: 'weekly',
    priority: 0.8,
  },
  {
    to: '/docs/*',
    title: `Documentation | ${SITE_NAME}`,
    description:
      'How the router works: authentication, chat completions, streaming, routing and fallback, errors, rate limits, billing and usage.',
    indexable: false,
  },
  {
    to: '/changelog',
    title: `Changelog | ${SITE_NAME}`,
    description:
      `Every shipped release, newest first: what changed in the router, the console and the API, and why. Follow along as new models and routing strategies land.`,
    indexable: true,
    changefreq: 'weekly',
    priority: 0.5,
  },
  {
    to: '/changelog/:slug',
    title: `Release notes | ${SITE_NAME}`,
    description: 'A single release: what changed and why.',
    indexable: false,
  },
  {
    to: '/legal/terms',
    title: `Terms of Service | ${SITE_NAME}`,
    description: `The agreement governing your use of ${SITE_NAME}: accounts and API keys, acceptable use, metered billing and credits, and how either side ends it.`,
    indexable: true,
    changefreq: 'monthly',
    priority: 0.2,
  },
  {
    to: '/legal/privacy',
    title: `Privacy Policy | ${SITE_NAME}`,
    description: `What ${SITE_NAME} stores and for how long: account and billing data, token counts, prompt and response logging, key encryption, and how to request deletion.`,
    indexable: true,
    changefreq: 'monthly',
    priority: 0.2,
  },
  {
    to: '/login',
    title: `Log in | ${SITE_NAME}`,
    description: `Sign in to ${SITE_NAME} to create API keys and read usage.`,
    indexable: false,
  },
  {
    to: '/signup',
    title: `Create your account | ${SITE_NAME}`,
    description: `Create a ${SITE_NAME} account: a workspace, a project and three environments are provisioned on signup.`,
    indexable: false,
  },
];

/**
 * The schema.org block for a route, when it declares one. Kept beside the
 * registry so a route that gains JSON-LD gains it in the same edit as its title.
 */
export function jsonLdFor(meta: SeoMeta, origin: string): Record<string, unknown> | null {
  switch (meta.jsonLd) {
    case 'WebSite':
      return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url: `${origin}/`,
        description: meta.description,
      };
    case 'SoftwareApplication':
      return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        url: `${origin}/`,
        description: meta.description,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Pay per request, metered per 1M tokens.' },
      };
    case 'ItemList':
      return {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: meta.title,
        description: meta.description,
        url: `${origin}${meta.to}`,
      };
    default:
      return null;
  }
}

/** True when `pattern` matches `pathname` (`:param` = one segment, `*` = rest). */
export function patternMatches(pattern: string, pathname: string): boolean {
  const norm = (p: string) => p.split('/').filter(Boolean);
  const pat = norm(pattern);
  const seg = norm(pathname.split('?')[0] ?? '');
  for (let i = 0; i < pat.length; i++) {
    const part = pat[i]!;
    if (part === '*') {
      // `*` is "one or more remaining segments", not "zero or more": `/docs/*`
      // must NOT claim `/docs`, which has its own entry and its own title. With
      // zero-or-more the wildcard also outranked it on pattern length, so /docs
      // served the section entry's noindex — caught by the route smoke test.
      return i < seg.length;
    }
    if (part.startsWith(':')) {
      if (i >= seg.length) return false;
      continue;
    }
    if (i >= seg.length || part !== seg[i]) return false;
  }
  // A pattern with no trailing `*` matches only the exact depth, so `/models`
  // does not claim `/models/compare`.
  return pat.length === seg.length;
}

/**
 * The metadata for a pathname: the longest matching public pattern, else a
 * generic entry. Longest-first matters — `/docs/:x` would otherwise shadow a
 * more specific route.
 */
export function seoFor(pathname: string): SeoMeta {
  let best: SeoMeta | null = null;
  let bestLen = -1;
  for (const meta of PUBLIC_SEO) {
    if (!patternMatches(meta.to, pathname)) continue;
    const len = meta.to.split('/').filter(Boolean).length;
    if (len > bestLen) {
      best = meta;
      bestLen = len;
    }
  }
  return (
    best ?? {
      to: pathname,
      title: `${SITE_NAME} — ${SITE_TAGLINE}`,
      description: SITE_DESCRIPTION,
      indexable: false,
    }
  );
}

/**
 * True when this server can serve `pathname` as a page — a public route from the
 * registry, or a guarded route the SPA renders behind RequireAuth.
 *
 * The server needs this to answer an unknown path with 404 instead of 200. The
 * shell alone cannot decide: the SPA would render its NotFound page either way,
 * so a 200 made every typo'd URL look indexable.
 *
 * Guarded routes are listed as PREFIXES because that is how the SPA nests them
 * (dashboard/keys, dashboard/team/roles, admin/models, …) and enumerating them
 * here would duplicate navigation.ts. `/login` and `/signup` are in the registry
 * above, so they are covered without a prefix rule.
 */
export function isKnownRoute(pathname: string): boolean {
  if (PUBLIC_SEO.some((m) => patternMatches(m.to, pathname))) return true;
  return /^\/(dashboard|admin)(\/|$)/.test(pathname) || /^\/invite\/[^/]+$/.test(pathname);
}

/**
 * The sitemap's paths: every indexable pattern EXCEPT the parameterised ones.
 *
 * The exclusion is the honest half of "a sitemap is a list of URLs": the
 * registry knows the ROUTES, not the rows, so `/models/:slug` cannot be
 * enumerated here — the catalogue can, and a future sitemap that wants 243 model
 * URLs must ask the database, not this file.
 *
 * The `indexable: false` on those parameterised routes is a DECISION, recorded
 * here because it is the largest thing this surface deliberately does not do:
 * `/models/:slug` and `/providers/:slug` are the catalogue's long tail, and they
 * stay noindex because the SPA renders their BODY on the client — a crawler's
 * first paint is this shell's `<div id="root">`, so indexing them would submit
 * ~250 pages of the same near-empty document under near-identical titles. Two
 * things unlock them, and both are prerequisites rather than preferences:
 * per-slug metadata in this registry (a schema.org block and a title that names
 * the model), and a body the server can render for that slug. Adding either one
 * alone is worse than leaving them noindex — a generic title on 250 pages is a
 * duplicate-content signal, which is what the landing page's title was before the
 * per-route rewrite.
 *
 * `/models/compare` is noindex for a different reason and stays that way: it is a
 * view composed entirely of query parameters, so every permutation of it is the same
 * page.
 */
export function sitemapPaths(): string[] {
  return PUBLIC_SEO.filter((m) => m.indexable && !m.to.includes(':') && !m.to.includes('*')).map(
    (m) => m.to,
  );
}
