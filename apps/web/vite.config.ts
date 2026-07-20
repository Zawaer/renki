import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 0.0.0.0 so this is reachable over Tailscale too, not just from this
    // machine — same trust boundary as the daemon (private tailnet only).
    host: "0.0.0.0",
  },
  // `vite preview` serves the production build (apps/web/dist) — this is what
  // an always-on host runs under pm2, as opposed to `dev`'s hot-reload server.
  // Separate port from `dev` so an always-on instance and a local `pnpm dev`
  // iteration loop never collide.
  preview: {
    port: 4173,
    host: "0.0.0.0",
  },
  // Relative base so the same build can be loaded from a VS Code webview URI
  // (Step 5), not just an absolute web root.
  base: "./",
});
