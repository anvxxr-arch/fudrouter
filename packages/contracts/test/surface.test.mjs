// packages/contracts/test/surface.test.mjs
//
// The compatibility gate for the migration.
//
// This is the Express-plane equivalent of what `internal/proxy/surface_test.go`
// already does for the Go plane. It exists because a modular-monorepo migration
// moves files and rewires imports, and the one thing that must not move is the
// HTTP surface clients depend on. These tests fail on a silent route change,
// which is the failure mode that has no natural detector.
//
// Run: node --test packages/contracts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, '..');
const REPO = resolve(HERE, '..', '..', '..');

const run = (script, args = []) =>
  execFileSync(process.execPath, [join(CONTRACTS, 'scripts', script), ...args], {
    cwd: CONTRACTS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const routes = JSON.parse(readFileSync(join(CONTRACTS, 'routes.json'), 'utf8'));
const inferenceYaml = readFileSync(join(CONTRACTS, 'openapi', 'inference.yaml'), 'utf8');

// The Go route table uses three pattern forms the OpenAPI document cannot use
// verbatim (a prefix pattern, and a methodless catch-all), so the mapping is
// explicit. A route with no entry here FAILS the test — that is the point: a new
// inference endpoint cannot be added without deciding how it is documented.
const INFERENCE_PATH_MAP = {
  'GET /health': '/health',
  'GET /v1/models': '/v1/models',
  'GET /v1/models/': '/v1/models/{model}', // ServeMux prefix pattern in Go
  'POST /v1/chat/completions': '/v1/chat/completions',
  'POST /v1/messages': '/v1/messages',
  'POST /v1/messages/count_tokens': '/v1/messages/count_tokens',
  '* /v1/': '/v1/{path}', // registered with no method
};

const documentedPaths = new Set(
  [...inferenceYaml.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => m[1]),
);

test('routes.json is current with the live source', () => {
  const out = run('extract-routes.mjs', ['--check']);
  assert.match(out, /OK/);
});

test('management.yaml is current with routes.json', () => {
  const out = run('gen-openapi-management.mjs', ['--check']);
  assert.match(out, /OK/);
});

test('the extraction is non-trivial (guards against an empty/greedy scan)', () => {
  // If a refactor moved the route registrations, a regex that silently matched
  // nothing would make every other assertion in this file vacuous.
  assert.ok(routes.counts.inference >= 7, `inference routes: ${routes.counts.inference}`);
  assert.ok(routes.counts.management >= 180, `management routes: ${routes.counts.management}`);
  assert.ok(routes.counts.middleware >= 10, `middleware entries: ${routes.counts.middleware}`);
});

test('every Go inference route is mapped into the OpenAPI document', () => {
  const unmapped = [];
  for (const r of routes.inference) {
    const key = `${r.method} ${r.path}`;
    const documented = INFERENCE_PATH_MAP[key];
    if (!documented) {
      unmapped.push(key);
      continue;
    }
    assert.ok(
      documentedPaths.has(documented),
      `${key} maps to ${documented}, which is not a path in inference.yaml`,
    );
  }
  assert.deepEqual(
    unmapped,
    [],
    'new inference route(s) with no OpenAPI mapping — decide how each is documented, ' +
      'then add it to INFERENCE_PATH_MAP. A route added to the Go table without a ' +
      'documented contract is exactly the drift this gate exists to catch.',
  );
});

test('no inference.yaml path is undocumented in the Go route table', () => {
  const mapped = new Set(Object.values(INFERENCE_PATH_MAP));
  const extra = [...documentedPaths].filter((p) => !mapped.has(p));
  assert.deepEqual(
    extra,
    [],
    'inference.yaml documents paths the Go route table does not serve (removed endpoint ' +
      'left behind in the contract, or a typo).',
  );
});

test('inference.yaml pins the whole error taxonomy', () => {
  const codes = [
    'AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR', 'RATE_LIMITED', 'INSUFFICIENT_CREDITS',
    'INVALID_REQUEST', 'MODEL_NOT_FOUND', 'CONTEXT_TOO_LONG', 'UNSUPPORTED_PARAMETER',
    'CONTENT_REJECTED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'CIRCUIT_OPEN',
    'UPSTREAM_ERROR', 'INTERNAL_ERROR',
  ];
  const missing = codes.filter((c) => !inferenceYaml.includes(`- ${c}`));
  assert.deepEqual(
    missing,
    [],
    'taxonomy codes missing from inference.yaml — clients branch on these and on the ' +
      'status each maps to (errors.go errTable).',
  );
});

test('management.yaml documents every management route', () => {
  const yaml = readFileSync(join(CONTRACTS, 'openapi', 'management.yaml'), 'utf8');
  const documented = [...yaml.matchAll(/^ {2}"(\/[^"]*)":\s*$/gm)].map((m) => m[1]);
  const operations = [...yaml.matchAll(/^ {4}(get|post|put|patch|delete|all|options|head):\s*$/gm)];
  assert.equal(
    operations.length,
    routes.counts.management,
    `management.yaml has ${operations.length} operations but the lock has ` +
      `${routes.counts.management} registrations`,
  );
  assert.ok(documented.length > 100, `only ${documented.length} documented paths`);
});

test('admin routes outnumber the rest — sanity on the tag/prefix split', () => {
  // The admin console API is the bulk of the surface; if this ratio inverts, the
  // extractor is probably reading the wrong directory.
  const admin = routes.management.filter((r) => r.path.startsWith('/api/admin/')).length;
  assert.ok(
    admin > routes.counts.management / 2,
    `admin routes ${admin} of ${routes.counts.management}`,
  );
});
