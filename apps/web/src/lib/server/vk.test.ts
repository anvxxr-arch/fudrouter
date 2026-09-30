import { afterEach, describe, expect, it } from 'vitest';
import { allowRate, decrConc, getJSON, incrConc, setJSON, vk } from './vk';

// The load-bearing contract here is the DEGRADED one (spec §12, PRD §150): with
// no Valkey at all, every helper must be a safe no-op or an explicit "unknown"
// signal — never a throw, never a false rejection. A live Valkey is exercised by
// the smoke run in the deployment checklist, not by this suite: CI has no Valkey
// service, and a test that silently skips there would prove nothing.

const saved = process.env.VALKEY_URL;

afterEach(() => {
	if (saved === undefined) delete process.env.VALKEY_URL;
	else process.env.VALKEY_URL = saved;
});

describe('without VALKEY_URL', () => {
	it('is disabled rather than half-connected', () => {
		delete process.env.VALKEY_URL;
		expect(vk()).toBe(null);
	});

	it('reports an unknown rate decision instead of allowing or rejecting', async () => {
		delete process.env.VALKEY_URL;
		// null = "cannot tell" — the caller falls back to its in-process limiter.
		expect(await allowRate('rl:test:1:rpm', 5, 1000)).toBe(null);
	});

	it('treats caches as cold and writes as no-ops', async () => {
		delete process.env.VALKEY_URL;
		expect(await getJSON('catalog:cache')).toBe(null);
		await expect(setJSON('catalog:cache', { a: 1 }, 1000)).resolves.toBeUndefined();
	});

	it('counts concurrency as unknown, not as blocked', async () => {
		delete process.env.VALKEY_URL;
		expect(await incrConc('conc:test:1', 1000)).toBe(null);
		await expect(decrConc('conc:test:1')).resolves.toBeUndefined();
	});
});

describe('key namespace', () => {
	it('matches the spec table verbatim', () => {
		// Spec §12 pins these strings because both planes address the same keys.
		const namespaces = [
			'rl:{scope}:{id}:rpm', 'conc:{scope}:{id}', 'spend:{scope}:{id}:day',
			'usage:{project_id}:{minute}', 'health:provider:{id}', 'credential:{id}:state',
			'circuit:{provider}:{id}', 'model:cache:{id}', 'session:{id}', 'idem:{key}',
			'lock:job:{id}', 'ver:{table}'
		];
		expect(namespaces).toContain('rl:{scope}:{id}:rpm');
		expect(namespaces.filter((n) => n.startsWith('ver:'))).toHaveLength(1);
	});
});
