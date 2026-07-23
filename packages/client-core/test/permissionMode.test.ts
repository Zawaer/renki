import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, resolvePermissionMode } from "../src/permissionMode.js";

describe("resolvePermissionMode", () => {
  it("passes through every known mode key", () => {
    for (const mode of PERMISSION_MODES) {
      expect(resolvePermissionMode(mode.key)).toBe(mode.key);
    }
  });

  it("falls back to the default for an unknown string", () => {
    expect(resolvePermissionMode("bypassPermissions")).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode("not-a-real-mode")).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode("")).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("falls back to the default for null/undefined (nothing persisted yet)", () => {
    expect(resolvePermissionMode(null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode(undefined)).toBe(DEFAULT_PERMISSION_MODE);
  });
});
