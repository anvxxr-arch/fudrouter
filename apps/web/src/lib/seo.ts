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
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority?: number;
  /** schema.org type for the route's JSON-LD block, when it has one. */
  jsonLd?: 'WebSite' | 'SoftwareApplication' | 'FAQPage' | 'ItemList';
}

/**
 * Metadata for every PUBLIC route, keyed by navigation.ts's pattern.
 *
 * The indexable content pages (/pricing, /models, /changelog, /docs) plus the
 * three trust pages (/security, /terms, /privacy), the changelog and docs
 * subtrees, the two auth screens and the root landing page. That is the entire
 * public surface — the provider directory is withdrawn. A console or admin route
 * is NOT listed (they all redirect an anonymous crawler to /login, so their
 * metadata would only ever be seen by a signed-in browser tab). `seoFor` falls
 * back for those.
 */
export const PUBLIC_SEO: readonly SeoMeta[] = [
  {
    // The root is a real page again (App.tsx renders <HomePage>), but it stays
    // `indexable: false` and out of the sitemap. It is listed here at all
    // because `isKnownRoute` reads this table: with no entry, `/` would answer
    // 404 — the one URL a visitor is most likely to type, and the one a crawler
    // checks first.
    //
    // `indexable: false` and no JSON-LD are deliberate rather than leftovers.
    // The landing page's offer is /pricing's offer restated, so indexing it
    // would submit a duplicate under a second URL; the page exists to be read
    // by a person who typed the domain, not to rank.
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
    to: '/features',
    title: `Features — routing, billing, limits | ${SITE_NAME}`,
    description:
      'Automatic fallback, combo routing, integer micro-unit credit billing, per-account limits, budget gates, audit logging and provider health — plus the roadmap.',
    indexable: true,
    changefreq: 'weekly',
    priority: 0.8,
  },
  {
    to: '/integrations',
    title: `Integrations — every tool that speaks OpenAI | ${SITE_NAME}`,
    description:
      'Setup guides for CLI coding agents, SDKs, frameworks and self-hosted upstreams: one base URL, one key, any model.',
    indexable: true,
    changefreq: 'weekly',
    priority: 0.7,
  },
  {
    to: '/models',
    title: `Models — every model and its price | ${SITE_NAME}`,
    description:
      'Every model the router serves, with input and output prices per 1M tokens, context window and capabilities.',
    indexable: true,
    changefreq: 'daily',
    priority: 0.8,
  },
  {
    // The index is indexable; the entries are not. An entry's body is rendered
    // client-side from the API, so a crawler that lands on one sees the shell
    // and no text — the same reason /docs/* is noindex. The index itself is
    // static enough to be worth a snippet: it lists every entry's title and
    // date, which is exactly what a "what's new" search wants.
    to: '/changelog',
    title: `Changelog | ${SITE_NAME}`,
    description: 'What shipped, and when: router, console and platform changes, newest first.',
    indexable: true,
    changefreq: 'weekly',
    priority: 0.6,
  },
  {
    to: '/changelog/*',
    title: `Changelog | ${SITE_NAME}`,
    description: 'What shipped, and when: router, console and platform changes, newest first.',
    indexable: false,
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
    // Not a page: the SPA redirects /signup to /login. The entry stays so
    // `isKnownRoute` keeps answering 200 + noindex for the old URL instead of a
    // soft 404, and so a crawler that followed a stale link sees a canonical
    // pointing at the page that actually renders. Title differs from /login's
    // on purpose — two entries sharing one title is the duplicate-content bug
    // this registry exists to prevent.
    to: '/signup',
    title: `Log in with Discord | ${SITE_NAME}`,
    description: `Sign in to ${SITE_NAME} with Discord. The first sign-in provisions your account.`,
    indexable: false,
  },
  {
    // The three trust pages. They are indexable because a buyer evaluating a
    // commercial router reads them before signing up, and they are the pages a
    // security questionnaire points at. Titles are distinct on purpose — two
    // entries sharing one title is the duplicate-content bug this registry
    // exists to prevent.
    to: '/security',
    title: `Security — how the router handles keys and data | ${SITE_NAME}`,
    description:
      'Only the SHA-256 hash of an API key is stored, provider credentials are encrypted at rest, an SSRF guard watches both planes, and data retention is minimal.',
    indexable: true,
    changefreq: 'weekly',
    priority: 0.6,
  },
  {
    // The status page is a live health readout, not marketing copy: its body
    // is rendered client-side from /api/status, so a crawler that lands on it
    // sees the shell and no text — the same reason /docs/* and /changelog/*
    // are noindex. It is listed here at all because `isKnownRoute` reads this
    // table: with no entry the server would answer 404 for /status, and the
    // footer link would be a dead link. `indexable: false` also keeps it out
    // of /sitemap.xml, which stays pinned at the nine content URLs.
    to: '/status',
    title: `Status — data plane health | ${SITE_NAME}`,
    description:
      'Live health of the FUDRouter data plane: gateway, dashboard, authentication, billing, database and major providers, with recent incidents and the latest probe result.',
    indexable: false,
  },
  {
    to: '/terms',
    title: `Terms of Service | ${SITE_NAME}`,
    description:
      'The terms that govern a FUDRouter account: acceptable use, credits and billing, service availability, and the limits of liability on both sides.',
    indexable: true,
    changefreq: 'yearly',
    priority: 0.3,
  },
  {
    to: '/privacy',
    title: `Privacy Policy | ${SITE_NAME}`,
    description:
      'What FUDRouter collects (usage metadata and account details), what it never stores (prompt and response content), how long data is kept, and the rights you hold.',
    indexable: true,
    changefreq: 'yearly',
    priority: 0.3,
  },
];

/**
 * The schema.org block for a route, when it declares one. Kept beside the
 * registry so a route that gains JSON-LD gains it in the same edit as its title.
 *
 * `ItemList` is the only branch the registry currently reaches (/pricing).
 * `WebSite` and `SoftwareApplication` are kept because they are the two shapes a
 * marketing page needs the moment one is added back; both described the root,
 * and the root declares no block — its offer duplicates /pricing's, so a second
 * structured description of the same product would be a duplicate rather than
 * an addition.
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
 * Titles for the GUARDED trees — /dashboard/* and /admin/*.
 *
 * Why a second table instead of entries in PUBLIC_SEO: `seoFor` is the one
 * function both planes call, so a console entry there would be read by the
 * server's head renderer and by /sitemap.xml. Every entry here is
 * `indexable: false` and `sitemapPaths()` filters on PUBLIC_SEO alone, so the
 * crawler's view is unchanged — what changes is the browser tab of a
 * signed-in user, which used to fall through to the landing page's title
 * (`fudrouter — one API key, every model`) on all twelve console routes.
 *
 * The labels mirror navigation.ts's CONSOLE_NAV / ADMIN_NAV, which is the
 * listing the user is looking at, so the tab names the page they are on.
 * `/admin` is one entry for the whole tree: the admin sections are a hub that
 * swaps content in place, and a title per section would need the section
 * registry duplicated here.
 */
const GUARDED_SEO: readonly SeoMeta[] = [
  { to: '/dashboard', title: `Overview | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/keys', title: `API keys | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/usage', title: `Usage | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/logs', title: `Request logs | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/playground', title: `Playground | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/limits', title: `Limits | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/budgets', title: `Budgets | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/aliases', title: `Aliases | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/routing', title: `Routing | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/alerts', title: `Alerts | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/billing', title: `Billing | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/billing/credits', title: `Credits | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/billing/invoices', title: `Invoices | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/billing/payment-methods', title: `Payment methods | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/account', title: `Account | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/dashboard/settings', title: `Settings | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/admin', title: `Admin console | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
  { to: '/admin/*', title: `Admin console | ${SITE_NAME}`, description: SITE_DESCRIPTION, indexable: false },
];
/**
 * The metadata for a pathname: the longest matching public pattern, else the
 * guarded table (console/admin), else a generic entry. Longest-first matters —
 * `/docs/:x` would otherwise shadow a more specific route, and
 * `/dashboard/billing/credits` must not be claimed by `/dashboard`.
 */
export function seoFor(pathname: string): SeoMeta {
  let best: SeoMeta | null = null;
  let bestLen = -1;
  for (const meta of [...PUBLIC_SEO, ...GUARDED_SEO]) {
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
 * (dashboard/keys, dashboard/limits, admin/models, …) and enumerating them
 * here would duplicate navigation.ts. `/login` and `/signup` are in the registry
 * above, so they are covered without a prefix rule.
 */
export function isKnownRoute(pathname: string): boolean {
  if (PUBLIC_SEO.some((m) => patternMatches(m.to, pathname))) return true;
  return /^\/(dashboard|admin)(\/|$)/.test(pathname);
}

/**
 * The sitemap's paths: every indexable pattern EXCEPT the parameterised ones.
 *
 * Today that is `/pricing`, `/changelog`, `/docs` and the three trust pages
 * (`/security`, `/terms`, `/privacy`) — the indexable routes left after the
 * catalogue, provider directory and legal pages were withdrawn, and the filter
 * stays written as a RULE rather than a literal set so a page added back to the
 * registry joins the sitemap by being marked `indexable: true`, with no second
 * edit here.
 *
 * The `:`/`*` exclusion is inert right now (neither indexable route is
 * parameterised) and is kept for the case it was written for: a pattern like
 * `/models/:slug` is a ROUTE, and the registry knows the route but not the rows.
 * A sitemap that wants 243 model URLs must ask the database, not this file —
 * emitting the literal `/models/:slug` as a `<loc>` would advertise a URL that
 * cannot resolve.
 *
 * `/` is excluded by its own `indexable: false`, not by this filter: it is a
 * real page whose offer duplicates /pricing's, so listing it would advertise a
 * second URL with the same content.
 */
export function sitemapPaths(): string[] {
  return PUBLIC_SEO.filter((m) => m.indexable && !m.to.includes(':') && !m.to.includes('*')).map(
    (m) => m.to,
  );
}
