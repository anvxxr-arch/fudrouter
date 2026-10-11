// tests/integration/harness.mjs — shared harness for the control-plane
// integration suite.
//
// The baseline (docs/migration/2026-10-10-phase0-baseline.md §5) records what
// this suite exists to close: the management API, better-auth sessions, the
// SSE first-flush and billing idempotency had NO coverage, so "backward
// compatible" was unverifiable. These tests exercise the real Express server
// over real HTTP against a real Postgres.
//
// Three rules, each learned from a way this could go wrong:
//
//  1. NEVER the application database. The server writes on sign-up
//     (better-auth's user.create.after hook provisions a workspace, project,
//     environments, role, member and billing account — index.mjs:391-400), so a
//     DSN naming the production database is a live write. The guard below
//     refuses it by name, mirroring backend/go/tests/helpers.go, which exists
//     because one run churned the live request_log ledger.
//  2. The server is a SUBPROCESS, not an import. index.mjs calls app.listen at
//     import time, so importing it for `app`/`auth` would bind a port as a side
//     effect of loading a module. It is spawned on a private port instead.
//  3. NODE_ENV=test, never production. index.mjs:404 sets trustedOrigins to []
//     under production, which rejects the test origin outright.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/web/tests/integration/harness.mjs — four levels up from this file is the
// repo root (tests/integration -> tests -> apps/web -> apps -> root).
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER = join(REPO, 'apps', 'web', 'server', 'index.mjs');

// The one database name the suite must never touch. Same reasoning as the Go
// guard: both are the same Postgres instance and the same role, so the name is
// the only reliable discriminator.
const PRODUCTION_DATABASES = new Set(['fudrouter']);

/** Extract the database name from a DSN without opening a connection. */
export function databaseName(dsn) {
	const lower = dsn.toLowerCase();
	if (!lower.startsWith('postgres://') && !lower.startsWith('postgresql://')) {
		for (const field of dsn.split(/\s+/)) {
			const i = field.indexOf('=');
			if (i > 0 && field.slice(0, i).toLowerCase() === 'dbname') return field.slice(i + 1);
		}
		return '';
	}
	let rest = dsn.slice(dsn.indexOf('://') + 3);
	const q = rest.indexOf('?');
	if (q >= 0) rest = rest.slice(0, q);
	const slash = rest.lastIndexOf('/');
	return slash >= 0 ? rest.slice(slash + 1) : '';
}

/**
 * The DSN the suite may run against. Skips locally when unset (so the 34
 * server/lib unit tests still run for a developer with no throwaway database)
 * but FAILS in CI: a silent skip lets the pipeline go green while the control
 * plane was never exercised, which is exactly the failure mode the baseline
 * records. Mirrors backend/go/tests/helpers.go RequireDB.
 */
export function requireTestDatabase() {
	const dsn = process.env.DATABASE_URL ?? '';
	if (!dsn) {
		if (process.env.CI) {
			throw new Error(
				'DATABASE_URL is not set in CI — the integration suite must run, not skip. ' +
					'Point it at a throwaway database (see backend/go/README.md).',
			);
		}
		return null;
	}
	if (process.env.FUDROUTER_ALLOW_PROD_TESTS) return dsn;
	const name = databaseName(dsn);
	if (PRODUCTION_DATABASES.has(name)) {
		throw new Error(
			`DATABASE_URL points at the ${JSON.stringify(name)} application database. ` +
				'Sign-up inserts user/account/session/workspace/project/environment rows, so this ' +
				'would write to production. Point DATABASE_URL at a throwaway database, or set ' +
				'FUDROUTER_ALLOW_PROD_TESTS=1 to accept the risk explicitly.',
		);
	}
	return dsn;
}

/** A free loopback port, so the suite never collides with a running console. */
async function freePort() {
	const { createServer } = await import('node:net');
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Boot the real server as a subprocess and wait until it answers /api/health.
 * Returns { baseUrl, port, stop, log }, or null when no throwaway database is
 * configured (the caller skips the file — see requireTestDatabase).
 */
export async function startServer(env = {}) {
	const dsn = requireTestDatabase();
	// No DSN locally: the caller must skip. Returning null rather than spawning
	// with a bogus DSN matters — `DATABASE_URL: null` serializes to the string
	// "null", which index.mjs:186 reads as truthy and hands to postgres(), so
	// every DB route would 500 with a connection error instead of skipping.
	if (!dsn) return null;
	const port = await freePort();
	// better-auth's trustedOrigins is a hardcoded allowlist for non-production
	// NODE_ENV (index.mjs:404): http://localhost:3000 and
	// http://127.0.0.1:3000. A random free port is NOT in it, so sign-up would
	// be rejected as an invalid origin and surface as a harness bug. The
	// listener keeps the private port; the advertised origin is the trusted
	// literal. This is deliberately NOT fixed by loosening the server's
	// allowlist — that list is the security property.
	const trustedOrigin = 'http://127.0.0.1:3000';
	const log = [];
	const child = spawn(process.execPath, [SERVER], {
		cwd: REPO,
		env: {
			...process.env,
			...env,
			DATABASE_URL: dsn,
			// test, not production: trustedOrigins must accept the test origin.
			NODE_ENV: 'test',
			// A private port, never .env.console's pinned 3002.
			PORT: String(port),
			HOST: '127.0.0.1',
			// The advertised origin must be one of the two literals in
			// index.mjs:404's trustedOrigins, or better-auth rejects sign-up as
			// an invalid origin. baseURL only affects link generation, not the
			// bind address, so the listener keeps the private port above.
			ORIGIN: trustedOrigin,
			BETTER_AUTH_URL: trustedOrigin,
			BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'integration-test-secret',
			CREDENTIALS_MASTER_KEY:
				process.env.CREDENTIALS_MASTER_KEY ?? 'ZnVkcm91dGVyLWNpLXRlc3QtbWFzdGVyLWtleS0zMmI='
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const collect = (stream) =>
		stream.on('data', (chunk) => {
			log.push(chunk.toString());
			if (log.length > 400) log.shift();
		});
	collect(child.stdout);
	collect(child.stderr);
	// A missing path or a bad interpreter emits 'error' while exitCode stays
	// null, so without this the readiness loop would burn the full 30s and then
	// report "did not become ready" with an empty log — hiding the real cause.
	let spawnError = null;
	child.on('error', (err) => {
		spawnError = err;
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (spawnError) {
			throw new Error(`could not start the server (${SERVER}): ${spawnError.message}`);
		}
		if (child.exitCode !== null) {
			throw new Error(`server exited early (code ${child.exitCode}):\n${log.join('')}`);
		}
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.ok) break;
		} catch {}
		if (Date.now() > deadline) {
			child.kill('SIGKILL');
			throw new Error(`server did not become ready in 30s:\n${log.join('')}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}

	return {
		baseUrl,
		port,
		log: () => log.join(''),
		async stop() {
			if (child.exitCode !== null) return;
			child.kill('SIGTERM');
			await new Promise((resolve) => {
				const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
				child.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	};
}

/** A unique email per run, so re-runs never collide on the unique index. */
export function uniqueEmail(tag = 'user') {
	return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
}

/** Sign up through the real better-auth endpoint and keep the session cookie. */
export async function signUp(baseUrl, { email, password = 'integration-pw-123', name = 'Integration' }) {
	const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password, name })
	});
	const body = await res.json().catch(() => null);
	const cookie = res.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? '';
	return { status: res.status, body, cookie };
}

/** A scratch directory that is removed when the test process exits. */
export function scratchDir(prefix = 'fudrouter-it-') {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const cleanup = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	};
	process.once('exit', cleanup);
	return dir;
}
