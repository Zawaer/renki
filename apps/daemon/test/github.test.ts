import { describe, expect, it } from "vitest";
import { cloneDirNames, parseRepoRef } from "../src/github.js";

/**
 * `parseRepoRef` is the only thing standing between a string off the wire and
 * a `git clone` argument, so its rejections matter more than its acceptances.
 */
describe("parseRepoRef", () => {
  it("accepts the shapes people actually paste", () => {
    for (const input of [
      "Zawaer/about-me",
      "  Zawaer/about-me  ",
      "https://github.com/Zawaer/about-me",
      "https://www.github.com/Zawaer/about-me",
      "http://github.com/Zawaer/about-me/",
      "https://github.com/Zawaer/about-me.git",
      "git@github.com:Zawaer/about-me.git",
      "github.com/Zawaer/about-me",
    ]) {
      expect(parseRepoRef(input), input).toBe("Zawaer/about-me");
    }
  });

  it("keeps dots, dashes and underscores in a repo name", () => {
    expect(parseRepoRef("acme/my_repo.v2-beta")).toBe("acme/my_repo.v2-beta");
  });

  it("rejects anything that isn't plainly one GitHub repo", () => {
    for (const input of [
      "",
      "   ",
      "about-me",
      "Zawaer/about-me/extra",
      "../../etc/passwd",
      "Zawaer/../../etc",
      "https://gitlab.com/Zawaer/about-me",
      "https://evil.com/Zawaer/about-me",
      "Zawaer/about me",
      "Zawaer/about;rm -rf /",
      "-flag/repo",
      "$(whoami)/repo",
      // Valid characters, but they'd escape the repos root as a directory name.
      "acme/..",
      "acme/.",
    ]) {
      expect(parseRepoRef(input), input).toBeNull();
    }
  });
});

describe("cloneDirNames", () => {
  it("tries the repo's own name first, then owner-name for a clash", () => {
    expect(cloneDirNames("Zawaer/about-me")).toEqual(["about-me", "Zawaer-about-me"]);
    expect(cloneDirNames("WilmervH/solmuton-website")).toEqual(["solmuton-website", "WilmervH-solmuton-website"]);
  });
});
