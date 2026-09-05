import { describe, expect, it } from "vitest";
import { displayBranch, isAutoBranch } from "../src/branches.js";

describe("auto-generated branch names", () => {
  it("recognises the daemon's crc/<6 hex> handles and nothing else", () => {
    expect(isAutoBranch("crc/3fd82f")).toBe(true);
    expect(isAutoBranch("crc/3FD82F")).toBe(false);
    expect(isAutoBranch("crc/feature")).toBe(false);
    expect(isAutoBranch("crc/3fd82f1")).toBe(false);
    expect(isAutoBranch("main")).toBe(false);
    expect(isAutoBranch(null)).toBe(false);
  });
  it("displayBranch hides handles and keeps chosen names", () => {
    expect(displayBranch("crc/3fd82f")).toBeNull();
    expect(displayBranch("fix/login")).toBe("fix/login");
    expect(displayBranch(null)).toBeNull();
  });
});
