// View/derivation helpers: provider health roll-up, security-signal
// evaluation and the ValKey liveness probe. Extracted verbatim from
// server/admin.mjs.
import net from 'node:net';

export function _deriveHealth({ requests, successRate, openIncidents, latestSnapshot }) { if (openIncidents.some((i) => i.severity === 'critical')) return 'outage'; if (latestSnapshot === 'unhealthy') return 'outage'; if (requests > 0 && successRate !== null && successRate < 50) return 'outage'; if (openIncidents.length > 0) return 'degraded'; if (latestSnapshot === 'degraded') return 'degraded'; if (requests > 0 && successRate !== null && successRate < 99) return 'degraded'; return 'operational'; }
export function _evalSignals(rules, windows) { const out = []; const th = (c) => { const t = Number(c?.threshold); return Number.isFinite(t) ? t : 0; }; const win = (c) => { const w = Number(c?.window_seconds); return (Number.isFinite(w) && w > 0) ? w : 3600; }; for (const rule of rules) { if (!rule.enabled) continue; for (const s of windows) { const t = th(rule.config); let hit = null; if (rule.kind === 'request_spike' && t > 0 && s.requests >= t) hit = { value: s.requests, message: `${s.requests} requests in the window (threshold ${t})` }; else if (rule.kind === 'auth_failures' && t > 0 && s.authFailures >= t) hit = { value: s.authFailures, message: `${s.authFailures} authentication failures (threshold ${t})` }; else if (rule.kind === 'key_rotation' && t > 0 && s.keyRotations >= t) hit = { value: s.keyRotations, message: `${s.keyRotations} API key rotations (threshold ${t})` }; else if (rule.kind === 'ip_distribution' && t > 0 && s.distinctIps >= t) hit = { value: s.distinctIps, message: `${s.distinctIps} distinct client addresses (threshold ${t} addresses)` }; else if (rule.kind === 'budget_anomaly' && s.budgetMicro !== null && s.budgetMicro > 0n && t > 0) { const pct = Number((s.spendMicro * 100n) / s.budgetMicro); if (pct >= t) hit = { value: pct, message: `${pct}% of the window budget spent (threshold ${t}%)` }; } else if (rule.kind === 'excessive_errors' && t > 0 && s.errorCount >= t) hit = { value: s.errorCount, message: `${s.errorCount} failed requests (threshold ${t})` }; else if (rule.kind === 'credential_abuse' && t > 0 && s.credentialAuthFailures >= t) hit = { value: s.credentialAuthFailures, message: `${s.credentialAuthFailures} upstream credential rejections (threshold ${t})` }; if (hit) out.push({ ruleId: rule.id, name: rule.name, kind: rule.kind, action: rule.action, at: s.windowStart, value: hit.value, threshold: t, windowSeconds: win(rule.config), message: hit.message }); } } out.sort((a, b) => new Date(b.at) - new Date(a.at)); return out; }
// Single raw-socket Valkey helper. Four call sites (admin.mjs x3 + _vkPing)
// previously inlined their own net.createConnection + RESP framing; the only
// differences were the command bytes and timeout. One function, one timeout
// policy, one cleanup path. (Long-term: adopt shared/control-lib/server/vk.ts
// ioredis client; this helper is the seam that makes that swap one edit.)
//
// AUTH is pipelined in front of the command, and the reply's "+OK" is stripped
// so callers still parse a single payload. Valkey answers pipelined commands in
// order, so one write gets both. Skipping AUTH is not an option: this host's
// Valkey sets requirepass, so every command answered "-NOAUTH Authentication
// required." — the bulk parser read that as "no data" (the admin panel showed
// zeros for INFO/DBSIZE) and _vkPing reported "up", because any bytes arriving
// counted as a healthy round trip. A wrong password still fails loudly: the
// reply is "-WRONGPASS…" and is not stripped.
export function _vkSend(cmd, timeoutMs = 3000) {
	if (!process.env.VALKEY_URL) return Promise.reject(new Error('VALKEY_URL is not set'));
	const u = new URL(process.env.VALKEY_URL);
	const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
	const user = dec(u.username || '');
	const pass = dec(u.password || '');
	const auth = !pass ? '' : (user && user !== 'default'
		? `*3\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(user)}\r\n${user}\r\n$${Buffer.byteLength(pass)}\r\n${pass}\r\n`
		: `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(pass)}\r\n${pass}\r\n`);
	return new Promise((res, rej) => {
		const sock = net.createConnection({ host: u.hostname, port: Number(u.port) || 6379 });
		let buf = '';
		const t = setTimeout(() => { try { sock.destroy(); } catch {} rej(new Error('timeout')); }, timeoutMs);
		sock.on('connect', () => sock.write(auth + cmd));
		sock.on('data', (d) => {
			buf += d.toString();
			clearTimeout(t);
			try { sock.destroy(); } catch {}
			res(auth && buf.startsWith('+OK\r\n') ? buf.slice(5) : buf);
		});
		sock.on('error', (e) => { clearTimeout(t); rej(e); });
	});
}
// An error reply is not "up": "-WRONGPASS"/"-NOAUTH" means the probe learned
// nothing about the instance, and reporting it healthy hides a broken panel.
export async function _vkPing() { if (!process.env.VALKEY_URL) return 'not configured'; try { const r = await _vkSend('*1\r\n$4\r\nPING\r\n'); return r.startsWith('-') ? 'down' : 'up'; } catch { return 'down'; } }
