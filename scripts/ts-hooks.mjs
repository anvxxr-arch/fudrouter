// scripts/ts-hooks.mjs — module hooks that let plain `node` load the `$lib` TS
// graph. Shared by every PM2 entrypoint that runs the control plane's modules
// outside SvelteKit (`workers.mjs`, `scheduler.mjs`), because duplicating this
// resolver in JS would drift the moment one copy learns a new alias.
//
// The hooks are needed for two reasons:
//   - `$lib/*` and `$app/*` are Vite/SvelteKit resolver aliases, not real
//     paths, so `node` cannot resolve them;
//   - the modules are TypeScript and `node` will not strip types on its own.
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Register the hooks and return the roots they resolved.
 *
 * Must be called at module top level, BEFORE any dynamic `import()` of the TS
 * graph — ESM hoists static imports, so importing this file is already early
 * enough as long as the TS import is a runtime `await import(...)`.
 *
 * @param {string} scriptRoot absolute path of the `scripts/` directory
 */
export function installTsHooks(scriptRoot) {
	const webRoot = resolvePath(scriptRoot, '..', 'apps', 'web');
	const libRoot = join(webRoot, 'src', 'lib');

	registerHooks({
		resolve(specifier, context, nextResolve) {
			let spec = specifier;
			if (spec.startsWith('$lib/')) spec = pathToFileURL(join(libRoot, spec.slice(5))).href;
			else if (spec === '$lib') spec = pathToFileURL(libRoot).href;
			else if (spec.startsWith('$app/')) {
				// The job handlers never touch SvelteKit app modules, but a transitive
				// import might; answering with an empty module keeps the fleet alive.
				spec = pathToFileURL(join(scriptRoot, 'app-shim.mjs')).href;
			} else if (spec.startsWith('$env/')) {
				spec = pathToFileURL(join(scriptRoot, 'env-shim.mjs')).href;
			}
			try {
				return nextResolve(spec, context);
			} catch (err) {
				// Extension-less relative/absolute TS imports (`./jobs`, `$lib/server/db`).
				if (/\.(ts|js)$/.test(spec) || spec.includes('node:')) throw err;
				for (const ext of ['.ts', '/index.ts', '.js', '/index.js']) {
					try {
						return nextResolve(spec + ext, context);
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

	return { webRoot, libRoot };
}

/** Absolute path to a module under `apps/web/src/lib`, for `await import()`. */
export function libUrl(libRoot, subpath) {
	return pathToFileURL(join(libRoot, subpath)).href;
}
