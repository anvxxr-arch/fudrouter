// PM2 ecosystem — fudrouter PRODUCTION (Go only)
// API :8011  UI/edge :8012
// No Node. No failover sidecar.
module.exports = {
  apps: [
    {
      name: "fudrouter",
      script: "/home/dwizzy/fudrouter-app/bin/fudrouter",
      interpreter: "none",
      cwd: "/home/dwizzy/fudrouter-app",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 30,
      min_uptime: "5s",
      env: {
        DATA_DIR: "/home/dwizzy/.fudrouter",
        FUDROUTER_API_ADDR: "0.0.0.0:8011",
        FUDROUTER_WEB_ADDR: "0.0.0.0:8012",
      },
    },
  ],
};
