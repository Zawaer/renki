import { describe, expect, it } from "vitest";
import { parseFileLink } from "../src/fileLinks.js";

const WT = "/home/me/.renki/worktrees/abc123";

describe("parseFileLink", () => {
  it("leaves web, mail and other scheme links alone", () => {
    for (const href of [
      "https://example.com/a.md",
      "http://localhost:3000/x",
      "mailto:you@example.com",
      "tel:+358401234567",
      "javascript:alert(1)",
      "data:text/plain,hi",
      "ftp://host/file.txt",
      "vscode://file/x",
      "//cdn.example.com/x.js",
      "foo:bar",
    ]) {
      expect(parseFileLink(href, WT), href).toBeNull();
    }
  });

  it("ignores in-page anchors and empty hrefs", () => {
    expect(parseFileLink("#section", WT)).toBeNull();
    expect(parseFileLink("", WT)).toBeNull();
    expect(parseFileLink(undefined, WT)).toBeNull();
    expect(parseFileLink("   ", WT)).toBeNull();
  });

  it("takes relative paths as worktree-relative", () => {
    expect(parseFileLink("notes.md", WT)).toEqual({ path: "notes.md" });
    expect(parseFileLink("./src/foo.ts", WT)).toEqual({ path: "src/foo.ts" });
    expect(parseFileLink("src/../README.md", WT)).toEqual({ path: "README.md" });
  });

  it("reads a line from #L42, #L42-L50, #L42C3 and :42", () => {
    expect(parseFileLink("src/foo.ts#L42", WT)).toEqual({ path: "src/foo.ts", line: 42 });
    expect(parseFileLink("src/foo.ts#L42-L50", WT)).toEqual({ path: "src/foo.ts", line: 42 });
    expect(parseFileLink("src/foo.ts#L42C3", WT)).toEqual({ path: "src/foo.ts", line: 42 });
    expect(parseFileLink("src/foo.ts:42", WT)).toEqual({ path: "src/foo.ts", line: 42 });
    expect(parseFileLink("foo.ts:42:7", WT)).toEqual({ path: "foo.ts", line: 42 });
    expect(parseFileLink("foo.ts:42-50", WT)).toEqual({ path: "foo.ts", line: 42 });
    expect(parseFileLink("foo.ts#L0", WT)).toEqual({ path: "foo.ts" });
  });

  it("drops a non-line fragment and a query", () => {
    expect(parseFileLink("docs/guide.md#install", WT)).toEqual({ path: "docs/guide.md" });
    expect(parseFileLink("a.txt?raw=1", WT)).toEqual({ path: "a.txt" });
  });

  it("decodes percent-escapes", () => {
    expect(parseFileLink("my%20notes.md", WT)).toEqual({ path: "my notes.md" });
    expect(parseFileLink("bad%E0%A4%A.md", WT)).toEqual({ path: "bad%E0%A4%A.md" });
  });

  it("accepts absolute paths inside the worktree", () => {
    expect(parseFileLink(`${WT}/src/foo.ts#L9`, WT)).toEqual({ path: "src/foo.ts", line: 9 });
    expect(parseFileLink(`${WT}/notes.md`, `${WT}/`)).toEqual({ path: "notes.md" });
    expect(parseFileLink(`file://${WT}/notes.md`, WT)).toEqual({ path: "notes.md" });
  });

  it("rejects absolute paths outside the worktree, or with no worktree known", () => {
    expect(parseFileLink("/etc/passwd", WT)).toBeNull();
    expect(parseFileLink(`${WT}-other/x.ts`, WT)).toBeNull();
    expect(parseFileLink(WT, WT)).toBeNull();
    expect(parseFileLink(`${WT}/x.ts`, null)).toBeNull();
    expect(parseFileLink("file:///etc/passwd", WT)).toBeNull();
  });

  it("rejects paths that climb out of the worktree", () => {
    expect(parseFileLink("../secret.txt", WT)).toBeNull();
    expect(parseFileLink("src/../../x", WT)).toBeNull();
    expect(parseFileLink(`${WT}/../other/x.ts`, WT)).toBeNull();
    expect(parseFileLink("~/.ssh/id_rsa", WT)).toBeNull();
  });

  it("still matches relative links when the worktree isn't known yet", () => {
    expect(parseFileLink("notes.md", null)).toEqual({ path: "notes.md" });
  });

  it("resolves relative to the directory the link was written in", () => {
    expect(parseFileLink("other.md", WT, "docs")).toEqual({ path: "docs/other.md" });
    expect(parseFileLink("../README.md", WT, "docs")).toEqual({ path: "README.md" });
    expect(parseFileLink("../../x", WT, "docs")).toBeNull();
  });
});
