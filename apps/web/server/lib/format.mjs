// View/derivation helpers: provider health roll-up, security-signal evaluation
// and the ValKey access helpers. The first two were extracted verbatim from
// server/admin.mjs; the ValKey helpers were rewritten onto the shared client
// (see the note below the two functions).
export function _deriveHealth({ requests, successRate, openIncidents, latestSnapshot }) { if (openIncidents.some((i) => i.severity === 'critical')) return 'outage'; if (latestSnapshot === 'unhealthy') return 'outage'; if (requests > 0 && successRate !== null && successRate < 50) return 'outage'; if (openIncidents.length > 0) return 'degraded'; if (latestSnapshot === 'degraded') return 'degraded'; if (requests > 0 && successRate !== null && successRate < 99) return 'degraded'; return 'operational'; }
export function _evalSignals(rules, windows) { const out = []; const th = (c) => { const t = Number(c?.threshold); return Number.isFinite(t) ? t : 0; }; const win = (c) => { const w = Number(c?.window_seconds); return (Number.isFinite(w) && w > 0) ? w : 3600; }; for (const rule of rules) { if (!rule.enabled) continue; for (const s of windows) { const t = th(rule.config); let hit = null; if (rule.kind === 'request_spike' && t > 0 && s.requests >= t) hit = { value: s.requests, message: `${s.requests} requests in the window (threshold ${t})` }; else if (rule.kind === 'auth_failures' && t > 0 && s.authFailures >= t) hit = { value: s.authFailures, message: `${s.authFailures} authentication failures (threshold ${t})` }; else if (rule.kind === 'key_rotation' && t > 0 && s.keyRotations >= t) hit = { value: s.keyRotations, message: `${s.keyRotations} API key rotations (threshold ${t})` }; else if (rule.kind === 'ip_distribution' && t > 0 && s.distinctIps >= t) hit = { value: s.distinctIps, message: `${s.distinctIps} distinct client addresses (threshold ${t} addresses)` }; else if (rule.kind === 'budget_anomaly' && s.budgetMicro !== null && s.budgetMicro > 0n && t > 0) { const pct = Number((s.spendMicro * 100n) / s.budgetMicro); if (pct >= t) hit = { value: pct, message: `${pct}% of the window budget spent (threshold ${t}%)` }; } else if (rule.kind === 'excessive_errors' && t > 0 && s.errorCount >= t) hit = { value: s.errorCount, message: `${s.errorCount} failed requests (threshold ${t})` }; else if (rule.kind === 'credential_abuse' && t > 0 && s.credentialAuthFailures >= t) hit = { value: s.credentialAuthFailures, message: `${s.credentialAuthFailures} upstream credential rejections (threshold ${t})` }; if (hit) out.push({ ruleId: rule.id, name: rule.name, kind: rule.kind, action: rule.action, at: s.windowStart, value: hit.value, threshold: t, windowSeconds: win(rule.config), message: hit.message }); } } out.sort((a, b) => new Date(b.at) - new Date(a.at)); return out; }
// ValKey helpers: the platform's shared client, a bounded liveness probe, and a
// bounded wait. The client itself is re-exported so the call sites have one
// import.
//
// This file used to hand-roll RESP over a raw socket: AUTH pipelined in front of
// the command, "+OK" stripped, replies parsed by slicing bulk headers, and each
// of the four call sites concatenating `$<len>` headers itself. Every probe also
// opened its own TCP connection -- the valkey panel alone opened a dozen per page
// load. The client that already existed for the workers and the scheduler does
// all of it: it owns VALKEY_URL, connects lazily, keeps one connection, and
// refuses to queue while disconnected (enableOfflineQueue:false +
// maxRetriesPerRequest:1), so a dead instance fails fast instead of hanging.
//
// What the client does NOT give us is a per-call deadline: a connected-but-silent
// Valkey would still hold a panel request open. `_vkWait` adds exactly that,
// per call, without changing the shared client's configuration for other planes.
import { _vk } from './platform-ts.mjs';

export { _vk };

/**
 * Await `promise`, but never longer than `ms`. A lost race is not an unhandled
 * rejection: the command's own rejection is consumed, so a timeout here cannot
 * crash the process later.
 */
export function _vkWait(promise, ms, label = 'command') {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`valkey ${label} timed out after ${ms}ms`)), ms);
	});
	promise.catch(() => {});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Ensure the shared client holds a connection before the first command.
 *
 * The client is lazy (lazyConnect) and refuses to queue (enableOfflineQueue:
 * false) so that a dead instance fails fast, which means the FIRST command in a
 * cold process is rejected with "Stream isn't writeable and enableOfflineQueue
 * options is false" while ioredis opens the socket in the background. Measured
 * against the live instance, not assumed: AUTH and PING by hand answer +OK and
 * +PONG while the same client's first ping() rejects, and its second one
 * succeeds. The console is long-lived, so this is a once-per-boot wait; every
 * call site afterwards runs warm. A failed connect is not fatal here -- ioredis
 * keeps retrying in the background, and the command's own error (or the
 * deadline) is what the panel ends up reporting.
 */
export async function _vkReady(c, ms = 4000) {
	if (!c || c.status === 'ready') return c;
	await _vkWait(
		new Promise((resolve) => {
			if (c.status === 'ready') return resolve();
			c.once('ready', resolve);
			// No-op when a connection attempt is already in flight; the 'ready'
			// listener is what this waits on either way.
			Promise.resolve(c.connect()).catch(() => {});
		}),
		ms,
		'connect'
	).catch(() => {});
	return c;
}

// An error reply is not "up": a rejected command (WRONGPASS, NOAUTH, an
// unreachable host) means the probe learned nothing about the instance, and
// reporting it healthy hides a broken panel. The raw-socket version stripped
// "+OK" and checked for a "-" prefix by hand to get this right -- and got it
// wrong once: the bulk parser read "-NOAUTH" as "no data", so INFO/DBSIZE showed
// zeros and this probe still said "up". ioredis rejects, so the catch is the
// whole rule.
export async function _vkPing() {
	const c = _vk();
	if (!c) return 'not configured';
	try {
		await _vkReady(c);
		await _vkWait(c.ping(), 3000, 'ping');
		return 'up';
	} catch {
		return 'down';
	}
}
