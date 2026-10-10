// packages/platform/ts-hooks.mjs — module hooks that let plain `node` load the control
// plane's TS graph. Shared by every entrypoint that runs the control plane's
// modules (`apps/workers/workers.mjs`, `apps/scheduler/scheduler.mjs`,
// `ops/probe-credentials.mjs`), because duplicating this
// resolver in JS would drift the moment one copy learns a new alias.
//
// The hooks are needed for two reasons:
//   - the modules import each other extension-less (`./jobs`, `./db`), which
//     `node` cannot resolve on its own;
//   - the modules are TypeScript and `node` will not strip types on its own.
//
// The `$lib/*`, `$app/*` and `$env/*` aliases this used to translate are gone:
// packages/platform was extracted from the SvelteKit app and every module now
// reaches its siblings with real relative paths, so there is nothing left to
// rewrite and no shim to keep alive for a second entrypoint to forget.
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
/**
 * Register the hooks and return the roots they resolved.
 *
 * Must be called at module top level, BEFORE any dynamic `import()` of the TS
 * graph — ESM hoists static imports, so importing this file is already early
 * enough as long as the TS import is a runtime `await import(...)`.
 *
 * The library root is this file's own directory: the loader lives inside the
 * package it loads, so there is nothing to derive and no caller can pass the
 * wrong path. (It used to take the caller's `scripts/` dir and walk up from it —
 * which broke silently the moment either side moved.)
 */
export function installTsHooks() {
	const libRoot = dirname(fileURLToPath(import.meta.url));
	registerHooks({
		resolve(specifier, context, nextResolve) {
			try {
				return nextResolve(specifier, context);
			} catch (err) {
				// Extension-less relative/absolute TS imports (`./jobs`, `./db`).
				if (/\.(ts|js)$/.test(specifier) || specifier.includes('node:')) throw err;
				for (const ext of ['.ts', '/index.ts', '.js', '/index.js']) {
					try {
						return nextResolve(specifier + ext, context);
					} catch {
						// keep trying
					}
				}
				throw err;
			}
		},
		load(url, context, nextLoad) {
			if (url.endsWith('.ts')) {
				const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
					mode: 'strip'
				});
				return { format: 'module', source, shortCircuit: true };
			}
			return nextLoad(url, context);
		}
	});
	return { libRoot };
}
/** Absolute path to a module under `packages/platform`, for `await import()`. */
export function libUrl(libRoot, subpath) {
	return pathToFileURL(join(libRoot, subpath)).href;
}
