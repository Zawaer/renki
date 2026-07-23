import { describe, expect, it } from "vitest";
import { diffLines, parseEditView, parsePlan, parseTodos } from "../src/toolViews.js";

describe("diffLines", () => {
  it("marks identical text as pure context", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("marks an empty old string ('' → one line, not zero, since split('\\n') on '' is ['']) as a leading empty del before the real additions", () => {
    // This is what a Write tool's diffLines("", content) actually renders as —
    // pinning it down here since it's a bit surprising, not because it's ideal.
    expect(diffLines("", "x\ny")).toEqual([
      { type: "del", text: "" },
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  it("treats two empty strings as a single empty context line (split('\\n') on '' is ['']))", () => {
    expect(diffLines("", "")).toEqual([{ type: "context", text: "" }]);
  });

  it("marks an empty new string as all real-content dels followed by a trailing empty add", () => {
    expect(diffLines("x\ny", "")).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" },
      { type: "add", text: "" },
    ]);
  });

  it("produces a minimal context/del/add sequence for a single changed line in the middle", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("keeps unchanged lines as context around an appended line", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("falls back to a straight replace (no LCS matching) once the line-count product exceeds the DP cutoff", () => {
    // 501 * 501 = 251,001 > MAX_DIFF_CELLS (250,000) — every line differs, so a
    // real LCS would still produce mostly del/add anyway, but the point of this
    // test is that the fallback path runs at all without a quadratic hang; a
    // shared first line ("shared") would show as context under real LCS but as
    // del+add under the size-cutoff fallback, which is what distinguishes them.
    const oldLines = ["shared", ...Array.from({ length: 500 }, (_, i) => `old-${i}`)];
    const newLines = ["shared", ...Array.from({ length: 500 }, (_, i) => `new-${i}`)];
    const result = diffLines(oldLines.join("\n"), newLines.join("\n"));
    expect(result[0]).toEqual({ type: "del", text: "shared" });
    expect(result).toHaveLength(oldLines.length + newLines.length);
    expect(result.filter((l) => l.type === "del")).toHaveLength(oldLines.length);
    expect(result.filter((l) => l.type === "add")).toHaveLength(newLines.length);
  });
});

describe("parseEditView", () => {
  it("parses an Edit tool call into a single hunk", () => {
    const view = parseEditView("Edit", { file_path: "/a.ts", old_string: "foo", new_string: "bar" });
    expect(view?.filePath).toBe("/a.ts");
    expect(view?.hunks).toHaveLength(1);
    expect(view?.hunks[0]!.lines).toEqual([
      { type: "del", text: "foo" },
      { type: "add", text: "bar" },
    ]);
  });

  it("returns null for an Edit call missing old_string/new_string", () => {
    expect(parseEditView("Edit", { file_path: "/a.ts", old_string: "foo" })).toBeNull();
    expect(parseEditView("Edit", { file_path: "/a.ts" })).toBeNull();
  });

  it("defaults filePath to null when file_path is absent", () => {
    expect(parseEditView("Edit", { old_string: "a", new_string: "b" })?.filePath).toBeNull();
  });

  it("parses a MultiEdit call into one hunk per edit", () => {
    const view = parseEditView("MultiEdit", {
      file_path: "/a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(view?.hunks).toHaveLength(2);
  });

  it("returns null for MultiEdit with an empty or non-array edits list", () => {
    expect(parseEditView("MultiEdit", { edits: [] })).toBeNull();
    expect(parseEditView("MultiEdit", { edits: "not-an-array" })).toBeNull();
    expect(parseEditView("MultiEdit", {})).toBeNull();
  });

  it("returns null for MultiEdit if any single edit in the list is malformed", () => {
    expect(
      parseEditView("MultiEdit", {
        edits: [{ old_string: "a", new_string: "A" }, { old_string: "b" /* missing new_string */ }],
      }),
    ).toBeNull();
  });

  it("parses a Write call as a diff against empty content (a leading empty del, then the real additions)", () => {
    const view = parseEditView("Write", { file_path: "/new.ts", content: "line1\nline2" });
    expect(view?.hunks[0]!.lines).toEqual([
      { type: "del", text: "" },
      { type: "add", text: "line1" },
      { type: "add", text: "line2" },
    ]);
  });

  it("returns null for a Write call missing content", () => {
    expect(parseEditView("Write", { file_path: "/new.ts" })).toBeNull();
  });

  it("returns null for an unrecognized tool name", () => {
    expect(parseEditView("Bash", { command: "ls" })).toBeNull();
  });

  it("returns null when toolInput isn't an object", () => {
    expect(parseEditView("Edit", null)).toBeNull();
    expect(parseEditView("Edit", "a string")).toBeNull();
    expect(parseEditView("Edit", 42)).toBeNull();
  });
});

describe("parseTodos", () => {
  it("parses a valid todos array", () => {
    const todos = parseTodos({
      todos: [
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Ship it", status: "pending" },
      ],
    });
    expect(todos).toEqual([
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
      { content: "Ship it", status: "pending", activeForm: undefined },
    ]);
  });

  it("returns null for an unrecognized status value", () => {
    expect(parseTodos({ todos: [{ content: "x", status: "done" }] })).toBeNull();
  });

  it("returns null when todos isn't an array, or toolInput isn't an object", () => {
    expect(parseTodos({ todos: "nope" })).toBeNull();
    expect(parseTodos(null)).toBeNull();
    expect(parseTodos("string")).toBeNull();
  });

  it("returns null if any todo entry is missing content", () => {
    expect(parseTodos({ todos: [{ status: "pending" }] })).toBeNull();
  });
});

describe("parsePlan", () => {
  it("extracts the plan markdown from an ExitPlanMode call", () => {
    expect(parsePlan("ExitPlanMode", { plan: "## Step 1\nDo the thing" })).toBe("## Step 1\nDo the thing");
  });

  it("returns null for any other tool name, regardless of input shape", () => {
    expect(parsePlan("Write", { plan: "not actually a plan call" })).toBeNull();
  });

  it("returns null when the plan field is missing or not a string", () => {
    expect(parsePlan("ExitPlanMode", {})).toBeNull();
    expect(parsePlan("ExitPlanMode", { plan: 42 })).toBeNull();
  });

  it("returns null when toolInput isn't an object", () => {
    expect(parsePlan("ExitPlanMode", null)).toBeNull();
  });
});
