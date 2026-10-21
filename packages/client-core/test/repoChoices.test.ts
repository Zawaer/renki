import type { GithubRepo, Repo } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { filterRepoChoices, repoChoices } from "../src/repoChoices.js";

const local = (name: string): Repo => ({ id: name.toLowerCase(), name, path: `/repos/${name}`, defaultBranch: "main" });
const gh = (fullName: string, description: string | null = null): GithubRepo => ({
  fullName,
  name: fullName.split("/")[1]!,
  description,
  isPrivate: false,
  isFork: false,
  pushedAt: null,
  defaultBranch: "main",
});

describe("repoChoices", () => {
  it("lists GitHub repos in GitHub's order, linked to their checkout, then local-only ones", () => {
    const rows = repoChoices([local("about-me"), local("scratch")], [gh("Zawaer/renki"), gh("Zawaer/About-Me")]);
    expect(rows.map((r) => [r.label, r.local?.id ?? null])).toEqual([
      ["Zawaer/renki", null],
      ["Zawaer/About-Me", "about-me"],
      ["scratch", "scratch"],
    ]);
  });

  it("falls back to just the local repos when GitHub isn't available", () => {
    expect(repoChoices([local("a")], null).map((r) => r.key)).toEqual(["local:a"]);
  });

  it("filters on name and description", () => {
    const rows = repoChoices([], [gh("Zawaer/renki", "Remote control"), gh("Zawaer/matka", "Location history")]);
    expect(filterRepoChoices(rows, "LOCATION").map((r) => r.label)).toEqual(["Zawaer/matka"]);
    expect(filterRepoChoices(rows, " ").length).toBe(2);
  });
});
