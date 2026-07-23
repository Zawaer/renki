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
  // Absolute base: a browser hard-loading a nested route like /session/:id
  // resolves "./assets/..." against that path, not the site root, and 404s.
  // The VS Code webview build (apps/vscode/src/html.ts) rewrites these
  // absolute-rooted asset paths to its own webview URI base instead.
  base: "/",
  build: {
    rollupOptions: {
      output: {
        // Split out vendor code that changes far less often than the app
        // itself, so a redeploy after an app-only change only invalidates the
        // app chunk's cache entry, not react/react-dom/react-router or the
        // markdown renderer (react-markdown + remark-gfm's AST/plugin
        // dependencies, together the single largest chunk) too. Also drops
        // every chunk under Vite's 500kB warning threshold.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
});
