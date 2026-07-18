import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Keep the daemon's stderr logger quiet during tests.
    env: { CRC_LOG_LEVEL: "error" },
  },
});
