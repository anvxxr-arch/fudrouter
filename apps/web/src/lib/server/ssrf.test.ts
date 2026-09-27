import { describe, it, expect } from 'vitest';
import { assertPublicUpstream } from './ssrf';

/**
 * The guard is only worth anything if it rejects the addresses an SSRF payload
 * actually uses. Each case below is a real technique, not a synthetic string.
 */
describe('assertPublicUpstream', () => {
	it('rejects the cloud metadata endpoint', async () => {
		// The single most valuable SSRF target: hands over instance credentials.
		const r = await assertPublicUpstream('http://169.254.169.254/latest/meta-data/');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/non-public/);
	});

	it('rejects loopback in every spelling', async () => {
		for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) {
			const r = await assertPublicUpstream(`http://${host}/models`);
			expect(r.ok, `${host} must be rejected`).toBe(false);
		}
	});

	it('rejects the IPv4-mapped loopback the kernel still connects to', async () => {
		// A filter that greps for "127." misses this one; the kernel does not.
		const r = await assertPublicUpstream('http://[::ffff:127.0.0.1]/models');
		expect(r.ok).toBe(false);
	});

	it('rejects RFC1918 space', async () => {
		for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
			const r = await assertPublicUpstream(`http://${host}/`);
			expect(r.ok, `${host} must be rejected`).toBe(false);
		}
	});

	it('rejects unspecified addresses, which route to localhost', async () => {
		for (const host of ['0.0.0.0', '[::]']) {
			const r = await assertPublicUpstream(`http://${host}/`);
			expect(r.ok, `${host} must be rejected`).toBe(false);
		}
	});

	it('rejects CGNAT and benchmarking space', async () => {
		// Both sit outside RFC1918 and are routable-looking, so a naive
		// private-range check lets them through.
		for (const host of ['100.64.0.1', '100.127.255.255', '198.18.0.1']) {
			const r = await assertPublicUpstream(`http://${host}/`);
			expect(r.ok, `${host} must be rejected`).toBe(false);
		}
	});

	it('rejects non-http schemes', async () => {
		// file:// and gopher:// turn a URL field into a local-file reader.
		for (const u of ['file:///etc/passwd', 'gopher://127.0.0.1:6379/_FLUSHALL']) {
			const r = await assertPublicUpstream(u);
			expect(r.ok, `${u} must be rejected`).toBe(false);
		}
	});

	it('rejects a public IP that is not a valid URL at all', async () => {
		const r = await assertPublicUpstream('not a url');
		expect(r.ok).toBe(false);
	});

	it('rejects a public host whose name resolves into private space', async () => {
		// The DNS-rebind case: the literal is clean, the answer is not. Only a
		// real resolution catches this, which is why the guard resolves instead
		// of pattern-matching the host string.
		const r = await assertPublicUpstream('http://localhost./models');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/non-public|resolve/);
	});

	it('accepts an ordinary public upstream', async () => {
		const r = await assertPublicUpstream('https://api.openai.com/v1');
		expect(r.ok).toBe(true);
	});

	it('accepts a public host that resolves to public space', async () => {
		const r = await assertPublicUpstream('https://example.com/');
		expect(r.ok).toBe(true);
	});
});
