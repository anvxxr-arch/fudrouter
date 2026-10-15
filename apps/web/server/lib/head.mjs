// Server-side head rendering: the shell index.html ships is the landing page's,
// so every public route served it a title, a description and a canonical that
// describe a DIFFERENT page than the URL the crawler asked for. Three
// consequences, all measured on this box:
//
//   - /pricing and /docs answered with `<title>FUDRouter — one API key, every
//     model</title>` and a canonical pointing at `/`, which is a duplicate-
//     content signal against the landing page;
//   - the sitemap was a hardcoded list of ten paths in index.mjs, so it could
//     not follow the registry and could not state a priority or a change
//     frequency;
//   - an unknown path answered 200 with the shell, so a crawler that reached
//     /nonsense indexed a page that does not exist (soft 404).
//
// This module rewrites the <head> of the built shell per request. It is NOT a
// renderer: the SPA still owns the body. What it guarantees is that the first
// paint a crawler sees is already correct — Vite's HTML is a template with a
// `<title>`, a description, a canonical and a JSON-LD block that this replaces
// rather than appends to, so there is never a duplicate tag.
//
// The registry lives in src/lib/seo.ts and is imported at runtime, exactly like
// lib/platform-ts.mjs imports packages/platform/*.ts: Node strips the types.
// One table, so the browser tab (components/Meta.tsx), this server and the
// sitemap cannot disagree.

import { readFileSync, statSync } from 'node:fs';

const seo = await import('../../src/lib/seo.ts');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for an HTML attribute or text node. Titles and descriptions
 * are ours, but `origin` comes from the request's Host header, which a client
 * controls — unescaped, that is reflected XSS in the head of every page. */
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * jsonLdTag serialises a JSON-LD object safe to inline in <script>.
 *
 * Plain JSON.stringify is NOT enough: it leaves `<` and `>` literal, so a Host
 * header containing `</script><script>alert(1)</script>` (or a model name that
 * did) closes the block and starts a new script. The `\u003c` escapes are valid
 * JSON and inert to the HTML tokenizer, which is the standard fix.
 */
function jsonLdTag(obj) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * readShell returns the built index.html, cached until the file's mtime changes
 * so a deploy is picked up without a restart while each request stays a string
 * concat.
 */
let cached = { html: null, mtimeMs: 0, path: null };
export function readShell(distDir) {
  const file = `${distDir}/index.html`;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  if (cached.path === file && cached.mtimeMs === stat.mtimeMs) return cached.html;
  const html = readFileSync(file, 'utf8');
  cached = { html, mtimeMs: stat.mtimeMs, path: file };
  return html;
}

/**
 * headFor builds the metadata block for one pathname. Pure: given the same path
 * and origin it returns the same string, which is what makes it testable without
 * an HTTP server.
 */
export function headFor(pathname, origin) {
  const meta = seo.seoFor(pathname);
  const url = `${origin}${pathname === '/' ? '/' : pathname}`;
  // og:url is the ABSOLUTE form of this page. It used to be left to the shell's
  // static `<meta property="og:url">`, which is stripped by the marker rewrite
  // and was never re-emitted here — so every page shipped without og:url while
  // headFor's own test asserted it. The test passed because it checked for the
  // string the shell used to carry, not the tag this function returns.
  const ogImage = `${origin}${seo.OG_IMAGE_PATH}`;
  const parts = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta name="robots" content="${meta.indexable ? 'index,follow' : 'noindex,follow'}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(seo.SITE_NAME)}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    // A link preview with no image is a text-only card, which every major
    // network renders smaller and clicks less. The asset is a real 1200x630
    // PNG (OG's own preferred ratio, so no scraper has to crop it).
    `<meta property="og:image" content="${esc(ogImage)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(seo.OG_IMAGE_ALT)}" />`,
    `<meta property="og:locale" content="en_US" />`,
    // summary_large_image requires an image; `summary` renders a small square
    // thumbnail instead, which is why the card type changes with the asset.
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(meta.title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
    `<meta name="twitter:image" content="${esc(ogImage)}" />`,
    `<meta name="twitter:image:alt" content="${esc(seo.OG_IMAGE_ALT)}" />`,
  ];
  const ld = seo.jsonLdFor(meta, origin);
  if (ld) parts.push(jsonLdTag(ld));
  return parts.join('\n    ');
}

// The shell tags this module replaces, by their own opening marker so the
// rewrite does not depend on the order index.html emits them in (the icon sits
// between the canonical and the JSON-LD block in the current template).
const HEAD_MARKERS = [
  { open: '<title>', close: '</title>' },
  { open: '<meta name="description"', close: '>' },
  { open: '<meta property="og:', close: '>' },
  { open: '<meta name="twitter:', close: '>' },
  { open: '<link rel="canonical"', close: '>' },
  { open: '<script type="application/ld+json">', close: '</script>' },
];

/**
 * withHead replaces the shell's SEO tags with the ones for `pathname`.
 *
 * The old tags are deleted one by one, and the new block is inserted right after
 * `<head>` — order-independent, so it does not matter where in the shell each
 * tag happens to sit. The earlier version sliced one span from the first marker
 * to the last, which in this shell swallowed the icon (index.html emits it
 * between the canonical and the JSON-LD block) and made the function refuse the
 * rewrite: every page kept serving the landing page's title.
 *
 * ZERO matching tags is a normal state, not a failure: the shell was reduced to
 * the tags the rewrite does not own (see index.html's comment) precisely so no
 * stale tag can survive a per-route rewrite. The old `if (spans.length === 0)
 * return html` guard was written when the shell carried a full set of tags, and
 * with an emptied shell it turned into a silent total failure — the page shipped
 * with NO title, canonical or robots at all, which is worse than the duplicate
 * tag the guard was protecting against. The only structural precondition now is
 * a `<head>` to insert into; everything else is copied through.
 *
 * Two markers overlapping means the template no longer matches this marker set
 * (a Vite change), so the html is returned unchanged rather than spliced into an
 * unknown shape.
 */
export function withHead(html, pathname, origin) {
  const spans = [];
  for (const { open, close } of HEAD_MARKERS) {
    for (let at = html.indexOf(open); at >= 0; at = html.indexOf(open, at + open.length)) {
      const stop = html.indexOf(close, at);
      if (stop < 0) continue;
      let start = at;
      while (start > 0 && (html[start - 1] === ' ' || html[start - 1] === '\t')) start--;
      spans.push({ start, end: stop + close.length });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) return html;

  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += html.slice(cursor, s.start);
    cursor = s.end;
  }
  out += html.slice(cursor);

  const at = out.indexOf('<head>');
  if (at < 0) return html;
  const insertAt = at + '<head>'.length;
  return `${out.slice(0, insertAt)}\n    ${headFor(pathname, origin)}${out.slice(insertAt)}`;
}

export { seo };
