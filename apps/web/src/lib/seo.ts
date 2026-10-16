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
 * Six entries: the two indexable content pages (/pricing, /docs), the docs
 * subtree, the two auth screens and the root redirect. That is the entire public
 * surface — the catalogue, the provider directory, the changelog and the legal
 * pages are withdrawn. A console or admin route is NOT listed (they all redirect
 * an anonymous crawler to /login, so their metadata would only ever be seen by a
 * signed-in browser tab). `seoFor` falls back for those.
 */
export const PUBLIC_SEO: readonly SeoMeta[] = [
  {
    // The root REDIRECTS to /pricing (App.tsx renders <Navigate>); it is not a
    // page. It is listed here anyway because `isKnownRoute` reads this table:
    // with no entry, `/` would answer 404 — the one URL a visitor is most
    // likely to type, and the one a crawler checks first.
    //
    // `indexable: false` and no JSON-LD are deliberate rather than leftovers.
    // A redirect has no content of its own, so indexing it would submit a
    // duplicate of /pricing under a second URL, and structured data describing
    // a page that immediately navigates away is a contradiction.
    to: '/',
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
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
    // ItemList: this page's entire payload is the catalogue's rows — every
    // model, its price and its context window — so it is the page a search
    // result for a model wants. It is now the ONLY route that declares JSON-LD
    // (the catalogue page that used to share this block is withdrawn), which
    // makes the `jsonLdFor` ItemList branch reachable from here and nowhere
    // else.
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
 *
 * `ItemList` is the only branch the registry currently reaches (/pricing).
 * `WebSite` and `SoftwareApplication` are kept because they are the two shapes a
 * marketing page needs the moment one is added back; both described the root,
 * and the root is a redirect now, which is why neither is referenced.
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
  // A pattern with no trailing `*` matches only the exact depth, so `/pricing`
  // does not claim `/pricing/anything`.
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
 * Today that is exactly two URLs — `/pricing` and `/docs`. They are the only
 * indexable routes left after the catalogue, provider directory, changelog and
 * legal pages were withdrawn, and the filter stays written as a RULE rather than
 * a literal pair so a page added back to the registry joins the sitemap by being
 * marked `indexable: true`, with no second edit here.
 *
 * The `:`/`*` exclusion is inert right now (neither indexable route is
 * parameterised) and is kept for the case it was written for: a pattern like
 * `/models/:slug` is a ROUTE, and the registry knows the route but not the rows.
 * A sitemap that wants 243 model URLs must ask the database, not this file —
 * emitting the literal `/models/:slug` as a `<loc>` would advertise a URL that
 * cannot resolve.
 *
 * `/` is excluded by its own `indexable: false`, not by this filter: it
 * redirects to /pricing, and a redirect is not a page to list.
 */
export function sitemapPaths(): string[] {
  return PUBLIC_SEO.filter((m) => m.indexable && !m.to.includes(':') && !m.to.includes('*')).map(
    (m) => m.to,
  );
}
