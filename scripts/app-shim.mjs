// $app/* shim for `scripts/workers.mjs`: the job handlers transitively import
// modules written for the SvelteKit resolver (e.g. audit.ts's `getRequestEvent`).
// Nothing here is reachable from a worker — every use is inside a try/catch or a
// request-scoped path — so the honest answer is "there is no request".
export function getRequestEvent() {
	throw new Error('$app/server is unavailable in scripts/workers.mjs (no request scope)');
}
