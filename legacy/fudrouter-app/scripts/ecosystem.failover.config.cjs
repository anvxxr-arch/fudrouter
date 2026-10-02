// PM2 ecosystem for fudrouter Go failover
// pm2 start scripts/ecosystem.failover.config.cjs
module.exports = {
  apps: [
    {
      name: "fudrouter-failover",
      script: "/home/dwizzy/fudrouter-app/bin/failover",
      interpreter: "none",
      cwd: "/home/dwizzy/fudrouter-app",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      env: {
        FAILOVER_PORT: "20126",
        FAILOVER_MODE: "passthrough",
        FAILOVER_BACKEND: "http://127.0.0.1:20128",
        DATA_DIR: "/home/dwizzy/.fudrouter",
        FAILOVER_DB_PATH: "/home/dwizzy/.fudrouter/db/data.sqlite",
        FAILOVER_TIMEOUT: "15000",
        FAILOVER_RACE_TIMEOUT: "30000",
        FAILOVER_COOLDOWN: "60000",
        FAILOVER_MAX_RACE: "4",
      },
    },
  ],
};
