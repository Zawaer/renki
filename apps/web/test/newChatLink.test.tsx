import type { RepoChoice } from "@renki/client-core";
import { describe, expect, it } from "vitest";
import { matchesProject, parseNewChatLink } from "../src/lib/newChatLink.js";

const choice = (over: Partial<RepoChoice>): RepoChoice => ({ key: "k", label: "l", description: null, isPrivate: true, fullName: null, local: null, ...over });

describe("parseNewChatLink", () => {
  it("reads the project from the query and the prompt from the fragment", () => {
    expect(parseNewChatLink("/new", "?project=life", "#prompt=fix%20it")).toEqual({ project: "life", prompt: "fix it" });
    expect(parseNewChatLink("/new/", "", "")).toEqual({ project: null, prompt: null });
  });

  it("only applies to /new, and treats a blank prompt as none", () => {
    expect(parseNewChatLink("/", "?project=life", "#prompt=x")).toBeNull();
    expect(parseNewChatLink("/new", "", "#prompt=%20%20")).toEqual({ project: null, prompt: null });
  });
});

describe("matchesProject", () => {
  it("matches a folder, an id or a GitHub name, ignoring case", () => {
    const local = { id: "life", name: "life", path: "/r/life", defaultBranch: "main", remote: "Zawaer/life" };
    expect(matchesProject(choice({ local }), "Life")).toBe(true);
    expect(matchesProject(choice({ local }), "zawaer/life")).toBe(true);
    expect(matchesProject(choice({ fullName: "Zawaer/matka" }), "matka")).toBe(true);
    expect(matchesProject(choice({ local }), "lif")).toBe(false);
  });
});
