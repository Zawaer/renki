import { describe, expect, it } from "vitest";
import { unpushedBadge, unpushedSummary } from "../src/unpushed.js";

describe("unpushed wording", () => {
  it("says commits and uncommitted files, singular and plural", () => {
    expect(unpushedSummary({ commits: 3, changedFiles: 0 })).toBe("3 commits not on GitHub");
    expect(unpushedSummary({ commits: 1, changedFiles: 2 })).toBe("1 commit not on GitHub, 2 uncommitted files");
    expect(unpushedSummary({ commits: 0, changedFiles: 1 })).toBe("1 uncommitted file");
  });

  it("badges commits first, a dot for files only, nothing when clean", () => {
    expect(unpushedBadge({ commits: 2, changedFiles: 5 })).toBe("↑2");
    expect(unpushedBadge({ commits: 0, changedFiles: 1 })).toBe("•");
    expect(unpushedBadge(null)).toBeNull();
  });
});
