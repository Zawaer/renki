// pm2 process definition for the always-on daemon.
//
//   pnpm build                        # compile protocol + daemon to dist/
//   pm2 start ecosystem.config.cjs    # start (reads ./.env via the daemon)
//   pm2 save && pm2 startup           # persist across reboots
//   pm2 logs crc-daemon               # tail logs
//
// Runs the COMPILED daemon (node dist/index.js), not tsx — more robust for a
// long-lived service. Config comes from the repo-root .env the daemon loads.
module.exports = {
  apps: [
    {
      name: "crc-daemon",
      script: "apps/daemon/dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // Daemon logs to stderr; let pm2 capture both streams.
      time: true,
    },
  ],
};
