// pm2 process definitions for the always-on host: the daemon, plus (optional)
// the web client served as a static build — for when you want the website
// itself always reachable too, not just run ad hoc with `pnpm --filter
// @crc/web dev` (a hot-reload dev server, not meant to run 24/7).
//
//   pnpm build                        # compile protocol + daemon + web
//   pm2 start ecosystem.config.cjs    # start both (reads ./.env via the daemon)
//   pm2 save && pm2 startup           # persist across reboots
//   pm2 logs crc-daemon               # tail daemon logs
//   pm2 logs crc-web                  # tail web logs
//
// The daemon runs the COMPILED output (node dist/index.js), not tsx — more
// robust for a long-lived service. Config comes from the repo-root .env the
// daemon loads. The web entry runs `vite preview` over the `apps/web/dist`
// build `pnpm build` produces — rebuild + `pm2 restart crc-web` to deploy a
// change, same as any static site.
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
    {
      name: "crc-web",
      script: "pnpm",
      args: "--filter @crc/web preview",
      cwd: __dirname,
      interpreter: "none", // `script` is the pnpm binary, not a JS file to hand to node
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
