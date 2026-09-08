import { describe, expect, it } from "vitest";
import { displayBranch, isAutoBranch } from "../src/branches.js";

describe("auto-generated branch names", () => {
  it("recognises the daemon's renki/<6 hex> handles and nothing else", () => {
    expect(isAutoBranch("renki/3fd82f")).toBe(true);
    expect(isAutoBranch("renki/3FD82F")).toBe(false);
    expect(isAutoBranch("renki/feature")).toBe(false);
    expect(isAutoBranch("renki/3fd82f1")).toBe(false);
    expect(isAutoBranch("main")).toBe(false);
    expect(isAutoBranch(null)).toBe(false);
  });

  /**
   * Sessions created before the project was renamed still carry `crc/` in the
   * database, and they'd start showing a meaningless branch name if this only
   * knew the new prefix.
   */
  it("still recognises the pre-rename crc/ handles", () => {
    expect(isAutoBranch("crc/3fd82f")).toBe(true);
    expect(displayBranch("crc/3fd82f")).toBeNull();
    // Only the handle shape, though — a branch someone chose still shows.
    expect(isAutoBranch("crc/feature")).toBe(false);
  });

  it("displayBranch hides handles and keeps chosen names", () => {
    expect(displayBranch("renki/3fd82f")).toBeNull();
    expect(displayBranch("fix/login")).toBe("fix/login");
    expect(displayBranch(null)).toBeNull();
  });
});
