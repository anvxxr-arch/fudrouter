#!/usr/bin/env node
// packages/contracts/scripts/extract-routes.mjs
//
// Extract the HTTP surface of BOTH planes mechanically into routes.json, so the
// surface is a file that can be diffed and reviewed instead of an emergent
// property of two codebases.
//
//   node scripts/extract-routes.mjs            # write routes.json
//   node scripts/extract-routes.mjs --check    # verify routes.json is current, exit 1 if not
//
// Why mechanical: the Go plane already pins its route table with a test
// (`internal/proxy/surface_test.go`) precisely because "adding a route, renaming
// one, or letting an exact pattern drift into the catch-all changed the API
// surface silently". The Express plane has 180+ registrations and no equivalent.
// This extractor is that equivalent, and it covers both planes with one artefact.
//
// It FAILS LOUDLY rather than guessing:
//   - a path built from a template variable it cannot resolve  -> error, exit 1
//   - a template variable with no matching `for (const X of [...])` loop in scope
//     -> error, exit 1
//
// It does NOT treat `app.use()` as a path prefix. In this codebase every
// `app.use('/api/...')` is rate-limiting or middleware (see index.mjs:648-659),
// while the routers register FULL paths themselves from index.mjs. Guessing they
// were prefixes would have produced /api/admin/api/admin/... paths. Mounts are
// recorded separately as `middleware` so the distinction stays visible.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const WEB_DIR = join(REPO, 'apps', 'console', 'server');
const GO_SURFACE = join(REPO, 'apps', 'router', 'internal', 'proxy', 'proxy.go');
const OUT = join(REPO, 'packages', 'contracts', 'routes.json');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'];
// delimiter captured in \2 so the lazy body stops at the SAME quote character.
const RE_ROUTE = new RegExp(
  String.raw`\b(?:app|router|r)\.(${METHODS.join('|')})\s*\(\s*(['"\`])([\s\S]*?)\2`,
  'g',
);
const RE_MOUNT = /\bapp\.use\s*\(\s*(['"`])([^'"`]+)\1/g;
// `for (const st of ['enable', 'disable']) { ... }` — the only way a path is
// built from a variable in this codebase.
const RE_LOOP = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]\s*\)/g;
const RE_STR = /['"`]([^'"`]+)['"`]/g;
// The catch-all `mux.Handle("/v1/", …)` carries NO method, unlike every other
// registration — so the method group is optional and a methodless pattern is
// recorded as `*`. Missing this silently dropped the most important route in the
// table (the one that swallows every unmatched /v1/ path).
const RE_GO = /mux\.Handle\w*\(\s*"([A-Z]+)?\s*([^"]+)"\s*,\s*([^)]+)\)/g;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const errors = [];
const sources = {};

function note(file, text) {
  sources[relative(REPO, file)] = sha256(text);
  return text;
}

// ---- Express plane -----------------------------------------------------------
const webFiles = readdirSync(WEB_DIR)
  .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
  .sort();

const management = [];
const middleware = [];

for (const name of webFiles) {
  const file = join(WEB_DIR, name);
  const src = note(file, readFileSync(file, 'utf8'));

  // 1. template variables available in this file, from `for (const X of [..])`.
  const loops = new Map();
  for (const m of src.matchAll(RE_LOOP)) {
    const values = [...m[2].matchAll(RE_STR)].map((s) => s[1]);
    if (values.length) loops.set(m[1], values);
  }

  // 2. mounts (recorded as middleware, never applied as a prefix).
  for (const m of src.matchAll(RE_MOUNT)) {
    const line = src.slice(0, m.index).split('\n').length;
    const tail = src.slice(m.index, m.index + 240);
    const kind = /rateLimit\s*\(/.test(tail)
      ? 'rate-limit'
      : /express\.static/.test(tail)
        ? 'static'
        : 'middleware';
    middleware.push({ path: m[2], file: name, line, kind });
  }
  // express.static(DIST) with no path string, and the SPA fallback.
  if (/express\.static\(\s*DIST\s*\)/.test(src)) {
    middleware.push({ path: '/', file: name, kind: 'static-spa-fallback' });
  }

  // 3. routes.
  for (const m of src.matchAll(RE_ROUTE)) {
    const method = m[1].toUpperCase();
    const raw = m[3];
    const line = src.slice(0, m.index).split('\n').length;

    const vars = [...raw.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((v) => v[1]);
    if (!vars.length) {
      management.push({ method, path: raw, file: name, line });
      continue;
    }
    for (const v of vars) {
      if (!loops.has(v)) {
        errors.push(
          `${name}:${line}: path \`${raw}\` uses \${${v}} but no ` +
            `\`for (const ${v} of [...])\` loop exists in the file — cannot resolve.`,
        );
      }
    }
    // cartesian expansion across every variable in the path
    let combos = [raw];
    for (const v of vars) {
      const values = loops.get(v) ?? [];
      combos = combos.flatMap((c) => values.map((val) => c.replaceAll(`\${${v}}`, val)));
    }
    for (const path of combos) {
      if (path.includes('${')) {
        errors.push(`${name}:${line}: unresolved template left in \`${path}\`.`);
        continue;
      }
      management.push({ method, path, file: name, line, expanded_from: raw });
    }
  }
}

// ---- Go plane ----------------------------------------------------------------
const goSrc = note(GO_SURFACE, readFileSync(GO_SURFACE, 'utf8'));
const inference = [];
for (const m of goSrc.matchAll(RE_GO)) {
  const handler = m[3].trim().replace(/^http\.HandlerFunc\(/, '').replace(/\)$/, '');
  inference.push({
    method: m[1] ?? '*',
    path: m[2],
    handler,
    file: 'apps/router/internal/proxy/proxy.go',
  });
}

if (errors.length) {
  console.error('extract-routes: refusing to guess.\n  ' + errors.join('\n  '));
  process.exit(1);
}

// ---- de-duplicate and sort ---------------------------------------------------
const key = (r) => `${r.method} ${r.path}`;
const dedupe = (rows) => {
  const seen = new Map();
  const dups = [];
  for (const r of rows) {
    if (seen.has(key(r))) dups.push(key(r));
    else seen.set(key(r), r);
  }
  return { rows: [...seen.values()].sort((a, b) => key(a).localeCompare(key(b))), dups };
};

const mg = dedupe(management);
const inf = dedupe(inference);
if (mg.dups.length) errors.push(`duplicate Express registrations: ${mg.dups.join(', ')}`);
if (inf.dups.length) errors.push(`duplicate Go registrations: ${inf.dups.join(', ')}`);
if (errors.length) {
  console.error('extract-routes: duplicate registrations.\n  ' + errors.join('\n  '));
  process.exit(1);
}

const byPrefix = (rows) => {
  const out = {};
  for (const r of rows) {
    const seg = r.path.split('/').slice(1, 3).join('/') || '(root)';
    out[seg] = (out[seg] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

const doc = {
  generated_by: 'packages/contracts/scripts/extract-routes.mjs',
  note:
    'Mechanical extraction of the live HTTP surface. Regenerate with `npm run extract -w @fudrouter/contracts`. ' +
    'A changed hash in `sources` with an unchanged route list means the surface survived an edit; ' +
    'a changed route list means the public API changed and downstream clients/OpenAPI must follow.',
  counts: {
    inference: inf.rows.length,
    management: mg.rows.length,
    management_get: mg.rows.filter((r) => r.method === 'GET').length,
    management_post: mg.rows.filter((r) => r.method === 'POST').length,
    middleware: middleware.length,
  },
  inference: inf.rows,
  management: mg.rows,
  management_by_prefix: byPrefix(mg.rows),
  middleware: middleware.sort((a, b) => a.path.localeCompare(b.path)),
  sources,
};

const serialised = JSON.stringify(doc, null, 2) + '\n';
const mode = process.argv.includes('--check') ? 'check' : 'write';

if (mode === 'check') {
  let current = null;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error('extract-routes --check: routes.json is missing. Run without --check.');
    process.exit(1);
  }
  const a = JSON.parse(current);
  const strip = ({ generated_by, ...rest }) => rest;
  // Compare the route SET, not just the totals: a message that prints identical
  // counts for a stale lock is worse than no message at all.
  const keyset = (d) => [
    ...d.inference.map((r) => `inference ${r.method} ${r.path} -> ${r.handler}`),
    ...d.management.map((r) => `management ${r.method} ${r.path} (${r.file})`),
  ];
  const lockKeys = new Set(keyset(a));
  const liveKeys = new Set(keyset(doc));
  const added = [...liveKeys].filter((k) => !lockKeys.has(k));
  const removed = [...lockKeys].filter((k) => !liveKeys.has(k));
  const mw = (d) => JSON.stringify(d.middleware);
  if (mw(a) !== mw(doc)) {
    added.push(`middleware table changed (${a.middleware.length} -> ${doc.middleware.length})`);
  }
  if (added.length || removed.length) {
    console.error(
      'extract-routes --check: routes.json is STALE — the live surface no longer matches the lock.\n' +
        (added.length ? added.map((k) => `  + ${k}`).join('\n') + '\n' : '') +
        (removed.length ? removed.map((k) => `  - ${k}`).join('\n') + '\n' : '') +
        '  The `+` routes are new (clients may depend on them). The `-` routes are GONE\n' +
        '  (that is the breaking change this lock exists to catch).\n' +
        '  If intentional, regenerate and review the diff.',
    );
    process.exit(1);
  }
  console.log(
    `extract-routes --check: OK — ${doc.counts.inference} inference + ${doc.counts.management} management routes match.`,
  );
  process.exit(0);
}

writeFileSync(OUT, serialised);
console.log(
  `extract-routes: wrote ${relative(REPO, OUT)}\n` +
    `  inference  : ${doc.counts.inference}\n` +
    `  management : ${doc.counts.management} (${doc.counts.management_get} GET, ${doc.counts.management_post} POST)\n` +
    `  middleware : ${doc.counts.middleware}\n` +
    `  by prefix  : ${JSON.stringify(doc.management_by_prefix)}`,
);
