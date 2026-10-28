import type { GithubRepo, Repo } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { filterRepoChoices, repoChoices } from "../src/repoChoices.js";

const local = (name: string, remote?: string | null): Repo => ({ id: name.toLowerCase(), name, path: `/repos/${name}`, defaultBranch: "main", remote });
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
  it("lists only GitHub repos, in GitHub's order, each linked to the checkout whose origin it is", () => {
    const rows = repoChoices(
      [local("about-me", "zawaer/about-me"), local("F35B", "Zawaer/F35B"), local("scratch", null), local("solmuton-website", "solmuton/solmuton-website")],
      [gh("Zawaer/renki"), gh("Zawaer/About-Me"), gh("WilmervH/solmuton-website"), gh("solmuton/solmuton-website")],
    );
    // A renamed repo's old folder (F35B) and one never pushed (scratch) aren't offered;
    // a same-named repo from another owner doesn't get this folder.
    expect(rows.map((r) => [r.label, r.local?.id ?? null])).toEqual([
      ["Zawaer/renki", null],
      ["Zawaer/About-Me", "about-me"],
      ["WilmervH/solmuton-website", null],
      ["solmuton/solmuton-website", "solmuton-website"],
    ]);
  });

  it("matches by folder name when the daemon doesn't report origins", () => {
    expect(repoChoices([local("about-me")], [gh("Zawaer/About-Me")])[0]!.local?.id).toBe("about-me");
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
