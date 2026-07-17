import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  // Relative base so the same build can be loaded from a VS Code webview URI
  // (Step 5), not just an absolute web root.
  base: "./",
});
