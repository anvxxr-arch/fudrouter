const path = require('node:path');

const ROOT = __dirname;

// PM2 entrypoints source the root .env at start, so this file
// holds no secrets and stays safe to commit.
module.exports = {
	apps: [
		{
			name: 'fudrouter-router',
			cwd: path.join(ROOT, 'services/router'),
			script: 'run.sh',
			interpreter: 'bash',
			env: {
				ROUTER_ADDR: '127.0.0.1:8100'
			},
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 5000,
			merge_logs: true,
			time: true
		},
		{
			// Worker fleet (PRD §75–76): usage/billing aggregation, invoices,
			// webhook delivery, alerts, provider/credential health, model/pricing
			// sync, retention cleanup. Shares the root .env via run-workers.sh —
			// no secrets here. kill_timeout > drain time: SIGTERM lets in-flight
			// handlers settle their job rows (never abandons one `running`).
			name: 'fudrouter-workers',
			cwd: ROOT,
			script: 'scripts/run-workers.sh',
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
			script: 'scripts/run-scheduler.sh',
			interpreter: 'bash',
			env: {
				NODE_ENV: 'production'
			},
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 10000,
			merge_logs: true,
			time: true
		}
	]
};
