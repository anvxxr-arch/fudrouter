const path = require('node:path');

const ROOT = __dirname;

// PM2 captures the environment of whichever *client* creates a process and
// stores it verbatim in ~/.pm2/dump.pm2, which `pm2 resurrect` replays forever.
// Create an app from an agent shell and that shell's whole env — provider API
// keys included — lands in the dump and in every child process env, surviving
// every later restart. The run*.sh entrypoints source the real config at start,
// so none of the below is needed by the services.
//
// filter_env matches key-name *substrings* and drops those keys from the env
// PM2 hands the app. `filter_env: true` is a no-op: Common.js tests
// `app.filter_env.length`, so only an array actually filters anything.
const FILTER_ENV = [
	'HERMES', // HERMES_CUSTOM_API_*_API_KEY, HERMES_SESSION_*, HERMES_SCRATCH_DIR
	'_hermes',
	'TERMINAL_', // TERMINAL_DOCKER_* — namespaces this project does not use
	'HINDSIGHT_',
	'BROWSERBASE_',
	'CLAUDECODE',
	'OMPCODE',
	'AI_AGENT',
	'MOA_TOOLS_DEBUG',
	'IMAGE_TOOLS_DEBUG',
	'VISION_TOOLS_DEBUG',
	'WEB_TOOLS_DEBUG',
	'TMPDIR', // points into the agent scratch dir, which is pruned at 72h
	'_tree_pids'
];

// PM2 entrypoints source the root .env at start, so this file
// holds no secrets and stays safe to commit.
module.exports = {
	apps: [
		{
			name: 'fudrouter-router',
			cwd: path.join(ROOT, 'backend/go'),
			script: 'run.sh',
			interpreter: 'bash',
			env: {
				ROUTER_ADDR: '127.0.0.1:8100',
				// The only ingress hop is Caddy on loopback: without this,
				// clientIP falls back to RemoteAddr=127.0.0.1 and the
				// ip_allowlist gate plus request_log.client_ip go blind.
				// Loopback only — never a public/Cloudflare IP (the router
				// never sees those directly).
				ROUTER_TRUSTED_PROXIES: '127.0.0.1'
			},
			filter_env: FILTER_ENV,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			// kill_timeout > graceful drain (srv.Shutdown 20s in main.go):
			// PM2 must not SIGKILL mid-drain.
			kill_timeout: 25000,
			min_uptime: 10000,
			merge_logs: true,
			time: true
		},
		{
			// Worker fleet (PRD §75–76): usage/billing aggregation, invoices,
			// webhook delivery, alerts, provider/credential health, model/pricing
			// sync, retention cleanup. Shares the root .env via run-workers.sh —
			// no secrets here. kill_timeout is 10s against an UNBOUNDED drain
			// (workers.ts stop() awaits inFlight with no deadline), so a handler
			// slower than 10s is SIGKILLed mid-flight and leaves a `running` row.
			// That row is not lost: requeueStaleJobs resurrects any `running` row
			// older than STALE_AFTER_MS_DEFAULT (10 min), and the claim's dedup
			// lock (lock:job:{id}, TTL tied to the same threshold) keeps the
			// resurrected job from being double-claimed while the original
			// handler is still alive. Tradeoff: a SIGKILLed long handler (the
			// batched retention sweep, the 12k-credential provider probe) delays
			// its job by up to 10 minutes rather than losing it.
			name: 'fudrouter-workers',
			cwd: ROOT,
			script: 'apps/workers/run.sh',
			interpreter: 'bash',
			env: {
				NODE_ENV: 'production',
				// Default is 1, which lets a single slow handler (an upstream
				// probe, a 12k-row sweep) block every other job — head-of-line
				// blocking on the whole fleet. The claim loop uses
				// FOR UPDATE SKIP LOCKED, so raising this is safe and is the
				// only reason the fleet can make progress in parallel.
				WORKER_CONCURRENCY: '4'
			},
			filter_env: FILTER_ENV,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 10000,
			merge_logs: true,
			time: true
		},
		{
			// Periodic scheduler (PRD §75–76): the ONLY producer of recurring
			// `job` rows. Deliberately its own process — a slow tick or a crash
			// here must not stop the drain loop. Shares the root .env via
			// run-scheduler.sh — no secrets here. Single-instance is a Valkey
			// lock plus the in-flight check inside schedulerTick.
			name: 'fudrouter-scheduler',
			cwd: ROOT,
			script: 'apps/scheduler/run.sh',
			interpreter: 'bash',
			env: {
				NODE_ENV: 'production'
			},
			filter_env: FILTER_ENV,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 10000,
			merge_logs: true,
			time: true
		},
		{
			// React control plane (console + JSON API). Caddy path-splits the
			// public host onto its port (the Go router owns :8100), and
			// run.sh sources .env.console which PINS that port — so the port
			// is not inherited from whatever shell started the process. Do not
			// add PORT to `env` here: .env.console is sourced after this env
			// is applied and would silently win, leaving two sources of truth.
			name: 'fudrouter-console',
			cwd: path.join(ROOT, 'apps/web'),
			script: 'run.sh',
			interpreter: 'bash',
			env: {
				NODE_ENV: 'production'
			},
			filter_env: FILTER_ENV,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 5000,
			merge_logs: true,
			time: true
		}
	]
};
