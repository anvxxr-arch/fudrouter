#!/usr/bin/env node
// packages/contracts/scripts/gen-openapi-management.mjs
//
// Derive `openapi/management.yaml` from `routes.json` (which is itself extracted
// mechanically from the Express source). Nothing here is hand-written, so the
// document cannot drift from the code: if a route moves, this file moves.
//
//   node scripts/gen-openapi-management.mjs           # write
//   node scripts/gen-openapi-management.mjs --check   # verify, exit 1 if stale
//
// What is modelled: paths, methods, path parameters, security, tags, and the
// owning source location.
//
// What is NOT modelled, deliberately: request/response BODIES. There are 180+
// management routes whose handlers speak Drizzle result objects; inventing
// schemas for them would produce a document that looks authoritative and is
// wrong. Every operation instead points at the source line that implements it.
// A body gets a schema only when someone reads the handler and writes it down —
// same rule as the inference document.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const ROUTES = join(REPO, 'packages', 'contracts', 'routes.json');
const INDEX = join(REPO, 'apps', 'web', 'server', 'index.mjs');
const OUT = join(REPO, 'packages', 'contracts', 'openapi', 'management.yaml');

const routes = JSON.parse(readFileSync(ROUTES, 'utf8'));

// --- which prefixes are PUBLIC ------------------------------------------------
// Mechanical: a prefix is public iff index.mjs mounts it with `_publicRead`,
// which is the rate limiter keyed by client IP (`_ipKey`). Everything else is
// keyed by `_limitKey` (the authenticated identity). This is the real
// discriminator in the code, not a guess about intent.
const indexSrc = readFileSync(INDEX, 'utf8');
const publicPrefixes = new Set();
for (const m of indexSrc.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*_publicRead\s*\)/g)) {
  publicPrefixes.add(m[1]);
}
if (!publicPrefixes.size) {
  console.error('gen-openapi-management: found no `_publicRead` mounts — refusing to guess which routes are public.');
  process.exit(1);
}

const isPublic = (path) => [...publicPrefixes].some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p));

// --- helpers ------------------------------------------------------------------
const yamlStr = (s) => JSON.stringify(s); // double-quoted, safe for every path here

// Express `:param` -> OpenAPI `{param}`.
const toOpenApiPath = (p) => p.replace(/:([A-Za-z_][\w]*)/g, '{$1}');
const paramsOf = (p) => [...p.matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]);

// `{*path}` is Express 5's splat: one greedy path parameter.
const isSplat = (p) => p.includes('{*');

function tagFor(path) {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'api') return seg[1] ?? 'api';
  if (seg[0] === 'robots.txt' || seg[0] === 'sitemap.xml') return 'seo';
  return 'app';
}

function operationId(r) {
  const clean = r.path
    .replace(/[:{}*]/g, '')
    .split('/')
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join('');
  return `${r.method.toLowerCase()}${clean}`;
}

// --- group --------------------------------------------------------------------
const paths = new Map();
for (const r of routes.management) {
  const key = toOpenApiPath(r.path);
  if (!paths.has(key)) paths.set(key, []);
  paths.get(key).push(r);
}
const sortedPaths = [...paths.entries()].sort((a, b) => a[0].localeCompare(b[0]));

// --- emit ---------------------------------------------------------------------
const L = [];
L.push('openapi: 3.1.0');
L.push('info:');
L.push('  title: FUDRouter Management API');
L.push('  version: 1.0.0');
L.push('  description: |');
L.push('    GENERATED FILE — do not edit by hand.');
L.push('    Source: packages/contracts/routes.json, extracted from apps/web/server/*.mjs');
L.push('    by packages/contracts/scripts/extract-routes.mjs.');
L.push('    Regenerate: npm run extract -w @fudrouter/contracts && npm run gen -w @fudrouter/contracts');
L.push('    ');
L.push('    Paths, methods, path parameters and security are mechanically derived and therefore');
L.push('    exact. Request/response BODIES are intentionally NOT modelled — 180+ handlers return');
L.push('    Drizzle result objects, and a fabricated schema would be worse than none. Each');
L.push('    operation carries `x-source` pointing at the line that implements it.');
L.push('    ');
L.push(`    Public prefixes (rate-limited by client IP via _publicRead): ${[...publicPrefixes].sort().join(', ')}.`);
L.push('    Every other route requires a session (or an admin capability) — see x-source.');
L.push('servers:');
L.push('  - url: http://127.0.0.1:3002');
L.push('    description: loopback listener of the Express plane (PORT pinned by .env.console)');
L.push('tags:');
const tags = [...new Set([...paths.keys()].map(tagFor))].sort();
for (const t of tags) L.push(`  - name: ${t}`);
L.push('paths:');

for (const [path, regs] of sortedPaths) {
  L.push(`  ${yamlStr(path)}:`);
  const byMethod = new Map();
  for (const r of regs) {
    if (!byMethod.has(r.method)) byMethod.set(r.method, []);
    byMethod.get(r.method).push(r);
  }
  for (const [method, list] of [...byMethod.entries()].sort()) {
    const r = list[0];
    const splat = isSplat(r.path);
    const pub = isPublic(r.path);
    L.push(`    ${method.toLowerCase()}:`);
    L.push(`      operationId: ${operationId(r)}`);
    L.push(`      tags: [${tagFor(r.path)}]`);
    L.push(`      summary: ${yamlStr(`${method} ${path}`)}`);
    L.push('      description: |');
    L.push(`        Registered at apps/web/server/${r.file}:${r.line}.`);
    if (r.expanded_from) {
      L.push(`        Expanded from the template \`${r.expanded_from}\`.`);
    }
    if (splat) {
      L.push('        Express 5 splat route: the trailing path segment is greedy.');
    }
    L.push(`        ${pub
      ? 'PUBLIC — rate-limited by client IP (_publicRead).'
      : 'Requires authentication; /api/admin routes additionally require an admin capability.'}`);
    const params = paramsOf(r.path);
    if (params.length || splat) {
      L.push('      parameters:');
      for (const p of params) {
        L.push(`        - name: ${p}`);
        L.push('          in: path');
        L.push('          required: true');
        L.push('          schema: { type: string }');
      }
      if (splat && !params.length) {
        L.push('        - name: path');
        L.push('          in: path');
        L.push('          required: true');
        L.push('          schema: { type: string }');
      }
    }
    if (pub) {
      L.push('      security: []');
    } else {
      L.push('      security:');
      L.push('        - session: []');
    }
    L.push('      x-source:');
    L.push(`        file: apps/web/server/${r.file}`);
    L.push(`        line: ${r.line}`);
    L.push('      x-body-schema: unmodelled');
    L.push('      responses:');
    L.push(`        "200":`);
    L.push('          description: Handler-defined JSON. Body not modelled — read x-source.');
    L.push('          content:');
    L.push('            application/json:');
    L.push('              schema: { type: object, additionalProperties: true }');
    L.push('        default:');
    L.push('          description: Handler-defined error envelope.');
    L.push('          content:');
    L.push('            application/json:');
    L.push('              schema: { type: object, additionalProperties: true }');
    if (list.length > 1) {
      L.push('      x-duplicate-registrations:');
      for (const d of list) L.push(`        - ${d.file}:${d.line}`);
    }
  }
}

L.push('components:');
L.push('  securitySchemes:');
L.push('    session:');
L.push('      type: apiKey');
L.push('      in: cookie');
L.push('      name: better-auth.session_token');
L.push('      description: better-auth session cookie (Discord OAuth or email/password).');
L.push('');
const doc = L.join('\n');

const mode = process.argv.includes('--check') ? 'check' : 'write';
if (mode === 'check') {
  let current = null;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error('gen-openapi-management --check: management.yaml is missing.');
    process.exit(1);
  }
  // Normalise away the line numbers before comparing. They are emitted into the
  // document on purpose (a human tracing an operation wants the registration
  // address), but they are not part of the API contract, and comparing them
  // verbatim made this gate red whenever an unrelated edit above a registration
  // shifted its line number.
  //
  // There are TWO sinks for the same number and both must be normalised:
  // `      line: 416` (:128) and the prose ``Registered at .../admin.mjs:416.``
  // (:128's description block). Normalising only the first left the prose
  // comparing verbatim -- 187 operations' worth -- so the gate stayed
  // line-sensitive while looking fixed. Verified by shifting a `line` in
  // routes.json without regenerating: the prose line was the first difference.
  const norm = (s) =>
    s
      .replace(/^(\s*)line: \d+$/gm, '$1line: <n>')
      .replace(/^(.*Registered at \S+?):\d+\.$/gm, '$1:<n>.');
  if (norm(current) !== norm(doc)) {
    const a = norm(current).split('\n');
    const b = norm(doc).split('\n');
    const firstDiff = a.findIndex((line, i) => line !== b[i]);
    console.error(
      `gen-openapi-management --check: management.yaml is STALE (first difference at line ${firstDiff + 1}).\n` +
        `  file: ${JSON.stringify(a[firstDiff] ?? '<eof>')}\n` +
        `  gen : ${JSON.stringify(b[firstDiff] ?? '<eof>')}\n` +
        '  Regenerate with: npm run gen -w @fudrouter/contracts',
    );
    process.exit(1);
  }
  console.log(`gen-openapi-management --check: OK — ${sortedPaths.length} paths match.`);
  process.exit(0);
}

writeFileSync(OUT, doc);
console.log(
  `gen-openapi-management: wrote ${relative(REPO, OUT)}\n` +
    `  paths: ${sortedPaths.length}  operations: ${routes.management.length}\n` +
    `  public prefixes: ${[...publicPrefixes].sort().join(', ')}\n` +
    `  bodies modelled: none (by design)`,
);
