const path = require('node:path');

const ROOT = __dirname;

// Both apps start through a run.sh that sources apps/web/.env, so this file
// holds no secrets and stays safe to commit.
module.exports = {
	apps: [
		{
			name: 'fudrouter-web',
			cwd: path.join(ROOT, 'apps/web'),
			script: 'run.sh',
			interpreter: 'bash',
			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: '3000'
			},
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 5000,
			merge_logs: true,
			time: true
		},
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
			// sync, retention cleanup. Shares apps/web/.env via run-workers.sh —
			// no secrets here. kill_timeout > drain time: SIGTERM lets in-flight
			// handlers settle their job rows (never abandons one `running`).
			name: 'fudrouter-workers',
			cwd: ROOT,
			script: 'scripts/run-workers.sh',
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
