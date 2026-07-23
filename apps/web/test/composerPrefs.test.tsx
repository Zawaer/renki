import { DEFAULT_EFFORT_KEY, DEFAULT_PERMISSION_MODE } from "@crc/client-core";
import { describe, expect, it } from "vitest";
import {
  loadEffortKey,
  loadModel,
  loadPermissionMode,
  saveEffortKey,
  saveModel,
  savePermissionMode,
} from "../src/lib/composerPrefs.js";

// Plain unit tests, no rendering — .tsx only to match this project's
// vitest.config.ts include glob (test/**/*.test.tsx).

describe("composerPrefs", () => {
  it("defaults permission mode/effort/model when nothing is persisted yet", () => {
    expect(loadPermissionMode()).toBe(DEFAULT_PERMISSION_MODE);
    expect(loadEffortKey()).toBe(DEFAULT_EFFORT_KEY);
    expect(loadModel()).toBe("");
  });

  it("round-trips a saved permission mode", () => {
    savePermissionMode("acceptEdits");
    expect(loadPermissionMode()).toBe("acceptEdits");
  });

  it("round-trips a saved effort key", () => {
    saveEffortKey("high");
    expect(loadEffortKey()).toBe("high");
  });

  it("round-trips a saved model, including a custom (not-in-list) model id", () => {
    saveModel("claude-opus-4-8");
    expect(loadModel()).toBe("claude-opus-4-8");
  });

  it("ignores a corrupted/unknown persisted permission mode and falls back to the default", () => {
    localStorage.setItem("crc.permissionMode", "bypassPermissions");
    expect(loadPermissionMode()).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("ignores a corrupted/unknown persisted effort key and falls back to the default", () => {
    localStorage.setItem("crc.effortKey", "turbo");
    expect(loadEffortKey()).toBe(DEFAULT_EFFORT_KEY);
  });
});
