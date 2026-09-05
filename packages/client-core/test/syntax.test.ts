import { describe, expect, it } from "vitest";
import { tokenizeJson, tokenizeShell, type SyntaxToken } from "../src/syntax.js";

/** Round-tripping matters most: colouring must never change the text shown. */
function joined(tokens: SyntaxToken[]): string {
  return tokens.map((t) => t.text).join("");
}
function of(tokens: SyntaxToken[], kind: SyntaxToken["kind"]): string[] {
  return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

describe("tokenizeShell", () => {
  it("marks the program, its flags and quoted strings", () => {
    const src = `psql -c "DELETE FROM ledger WHERE idem IS NULL" --file cleanup.sql`;
    const t = tokenizeShell(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "command")).toEqual(["psql"]);
    expect(of(t, "argument")).toEqual(["cleanup.sql"]);
    expect(of(t, "flag")).toEqual(["-c", "--file"]);
    expect(of(t, "string")).toEqual([`"DELETE FROM ledger WHERE idem IS NULL"`]);
  });

  it("treats the word after a pipe or semicolon as a new command", () => {
    const t = tokenizeShell("git log --oneline | head -3; echo done");
    expect(of(t, "command")).toEqual(["git", "head", "echo"]);
    expect(of(t, "operator")).toEqual(["|", ";"]);
  });

  it("picks out variables (including inside double quotes), substitutions and comments", () => {
    const src = 'echo "$HOME/${DIR}" $(date) # a note';
    const t = tokenizeShell(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "variable")).toEqual(["$HOME", "${DIR}"]);
    expect(of(t, "comment")).toEqual(["# a note"]);
    expect(of(t, "command")).toContain("date");
  });

  it("tolerates an unterminated quote instead of losing the rest of the line", () => {
    const src = `grep "unfinished`;
    expect(joined(tokenizeShell(src))).toBe(src);
    expect(of(tokenizeShell(src), "string")).toEqual([`"unfinished`]);
  });

  it("handles && and >> as single operators", () => {
    const t = tokenizeShell("make build && ./run >> out.log");
    expect(of(t, "operator")).toEqual(["&&", ">>"]);
    expect(of(t, "command")).toEqual(["make", "./run"]);
  });
});

describe("tokenizeJson", () => {
  it("separates keys from string values, and marks numbers and literals", () => {
    const src = `{"file_path": "/tmp/a.txt", "limit": 120, "ok": true, "x": null}`;
    const t = tokenizeJson(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "key")).toEqual([`"file_path"`, `"limit"`, `"ok"`, `"x"`]);
    expect(of(t, "string")).toEqual([`"/tmp/a.txt"`]);
    expect(of(t, "number")).toEqual(["120"]);
    expect(of(t, "literal")).toEqual(["true", "null"]);
  });

  it("keeps pretty-printed whitespace and escapes intact", () => {
    const src = `{\n  "msg": "say \\"hi\\"",\n  "n": -12.5\n}`;
    const t = tokenizeJson(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "key")).toEqual([`"msg"`, `"n"`]);
    expect(of(t, "number")).toEqual(["-12.5"]);
  });
});
