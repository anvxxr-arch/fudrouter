import { env } from '$env/dynamic/private';

// Real liveness probe against the Go data plane, not a placeholder. A short
// timeout keeps the page snappy when the router is down.
export const load = async () => {
	const base = env.ROUTER_BASE_URL ?? 'http://127.0.0.1:8100';
	const started = Date.now();
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 4000);
		const health = await fetch(`${base}/health`, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!health.ok) return { up: false, service: '', models: 0, latencyMs: Date.now() - started };

		const service = (await health.json()).service ?? '';
		let models = 0;
		const list = await fetch(`${base}/v1/models`);
		if (list.ok) models = ((await list.json()).data ?? []).length;

		return { up: true, service, models, latencyMs: Date.now() - started };
	} catch {
		return { up: false, service: '', models: 0, latencyMs: Date.now() - started };
	}
};
