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
				ROUTER_ADDR: '127.0.0.1:8100',
				// Spec §1: farmed-account providers are status='dev'. The router
				// hides them unless this is explicitly set — remove this line in
				// production and xai-grok disappears from /v1/models.
				ROUTER_ALLOW_DEV_PROVIDERS: '1'
			},
			autorestart: true,
			max_restarts: 10,
			restart_delay: 2000,
			kill_timeout: 5000,
			merge_logs: true,
			time: true
		}
	]
};
